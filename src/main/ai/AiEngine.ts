import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { ActionPlanSchema, BrowserActionSchema, type ActionPlan, type AiStatus } from '@shared/types/ai'
import { z } from 'zod'
import { WORKSPACE_ICONS } from '@shared/types/workspace'
import type { SettingsStore } from '../settings/SettingsStore'
import type { Database } from '../db/Database'
import { createLogger } from '../logger'
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  describeProviderError,
  type LLMProvider
} from './LLMProvider'

const log = createLogger('ai')

const SYSTEM_PROMPT = `You help someone organise their browser tabs.

You can ONLY propose actions from the provided schema. You have no other
capabilities: you cannot send messages, make purchases, submit forms, change
settings, grant permissions, or delete anything. If a request needs something
outside the schema, set "refusal" and explain briefly what you cannot do.

Rules:
- Only use tab ids that appear in the context. Never invent one.
- Never propose closing a tab unless the request clearly asks to close things.
- Prefer fewer, larger groups over many tiny ones.
- "understanding" must restate the request in one sentence so the user can see
  if you misread it.
- Every action is previewed and the user must approve it before anything runs.`

/** The JSON Schema the provider is forced to produce. */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    understanding: { type: 'string', description: 'One sentence restating the request.' },
    refusal: {
      type: ['string', 'null'],
      description: 'Set when the request cannot be met with the available actions.'
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'organize-tabs',
              'create-workspace',
              'move-tabs',
              'close-tabs',
              'save-tabs',
              'reading-queue'
            ]
          },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                tabIds: { type: 'array', items: { type: 'string' } }
              },
              required: ['name', 'tabIds']
            }
          },
          name: { type: 'string' },
          icon: {
            type: 'string',
            description: 'One of the browser’s workspace icon names.',
            enum: [...WORKSPACE_ICONS]
          },
          tabIds: { type: 'array', items: { type: 'string' } },
          orderedTabIds: { type: 'array', items: { type: 'string' } },
          toWorkspaceId: { type: 'string' },
          toBookmarkFolder: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['kind']
      }
    }
  },
  required: ['understanding', 'actions']
}

const ProviderResponseSchema = z.object({
  understanding: z.string(),
  refusal: z.string().nullable().optional(),
  actions: z.array(z.unknown())
})

/**
 * The optional AI layer.
 *
 * Entirely inert until a provider *and* a key are configured — `status()` reports
 * `configured: false` and every AI surface hides rather than nagging. The browser
 * is fully usable, and every feature except this one works, with AI switched off.
 */
export class AiEngine {
  private readonly plans = new Map<string, ActionPlan>()

  constructor(
    private readonly settings: SettingsStore,
    private readonly db: Database
  ) {}

  status(): AiStatus {
    const settings = this.settings.getAll()
    return {
      configured: settings.aiProvider !== 'none' && this.readKey() !== null,
      provider: settings.aiProvider,
      model: settings.aiModel,
      mayReadPageContent: settings.aiMayReadPageContent
    }
  }

  /**
   * Stores the API key encrypted at rest.
   *
   * `safeStorage` uses the OS keychain (DPAPI on Windows), so the key is not
   * sitting in a readable JSON blob next to the browsing history. It is never
   * returned to the renderer — only whether one exists.
   */
  setApiKey(plainKey: string): boolean {
    if (plainKey === '') {
      this.db.connection.prepare(`DELETE FROM ai_secrets WHERE id = 1`).run()
      return true
    }
    if (!safeStorage.isEncryptionAvailable()) {
      log.error('OS encryption unavailable; refusing to store the key in plaintext')
      return false
    }
    const encrypted = safeStorage.encryptString(plainKey)
    this.db.connection
      .prepare(
        `INSERT INTO ai_secrets (id, api_key) VALUES (1, @key)
         ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key`
      )
      .run({ key: encrypted })
    return true
  }

  private readKey(): string | null {
    const row = this.db.connection.prepare('SELECT api_key FROM ai_secrets WHERE id = 1').get() as
      | { api_key: Buffer }
      | undefined
    if (!row?.api_key) return null
    try {
      return safeStorage.decryptString(row.api_key)
    } catch {
      // A key encrypted by a different OS user or machine cannot be read back.
      log.warn('stored API key could not be decrypted')
      return null
    }
  }

  private provider(): LLMProvider | null {
    const settings = this.settings.getAll()
    const key = this.readKey()

    if (settings.aiProvider === 'anthropic') {
      if (!key) return null
      return new AnthropicProvider(key, settings.aiModel)
    }
    if (settings.aiProvider === 'openai-compatible') {
      return new OpenAICompatibleProvider(
        settings.aiBaseUrl || 'http://localhost:11434/v1',
        key ?? '',
        settings.aiModel
      )
    }
    return null
  }

  /**
   * UNDERSTAND → PLAN. Produces a plan for review; nothing is executed here.
   */
  async proposePlan(
    userRequest: string,
    context: string,
    buildPreview: (actions: ActionPlan['actions']) => ActionPlan['preview']
  ): Promise<{ ok: true; plan: ActionPlan } | { ok: false; error: string }> {
    const provider = this.provider()
    if (!provider) return { ok: false, error: 'No AI provider is configured.' }

    let raw: unknown
    try {
      raw = await provider.proposePlan({
        system: SYSTEM_PROMPT,
        userRequest,
        context,
        outputSchema: OUTPUT_SCHEMA
      })
    } catch (error) {
      return { ok: false, error: describeProviderError(error) }
    }

    const envelope = ProviderResponseSchema.safeParse(raw)
    if (!envelope.success) {
      return { ok: false, error: 'The model returned a plan in an unexpected shape.' }
    }

    // Each action is validated individually against the discriminated union.
    // Anything that is not a declared variant is dropped rather than failing the
    // whole plan — a model that invents one capability should not lose the five
    // legitimate actions alongside it.
    const actions: ActionPlan['actions'] = []
    let rejected = 0
    for (const candidate of envelope.data.actions) {
      const parsed = BrowserActionSchema.safeParse(candidate)
      if (parsed.success) actions.push(parsed.data)
      else rejected += 1
    }
    if (rejected > 0) {
      log.warn(`rejected ${rejected} proposed action(s) that were not in the allowed set`)
    }

    const plan: ActionPlan = {
      planId: randomUUID(),
      understanding: envelope.data.understanding,
      actions,
      preview: buildPreview(actions),
      refusal:
        envelope.data.refusal ??
        (actions.length === 0
          ? rejected > 0
            ? 'The model proposed something this browser does not allow it to do.'
            : 'Nothing to do for that request.'
          : null)
    }

    const validated = ActionPlanSchema.safeParse(plan)
    if (!validated.success) return { ok: false, error: 'Could not build a valid plan.' }

    this.plans.set(plan.planId, plan)
    return { ok: true, plan }
  }

  /** Retrieves a plan for execution. Consumed, so a plan runs at most once. */
  takePlan(planId: string): ActionPlan | null {
    const plan = this.plans.get(planId) ?? null
    this.plans.delete(planId)
    return plan
  }

  logActivity(
    request: string,
    understanding: string,
    outcome: string,
    actionCount: number,
    detail: string
  ): void {
    this.db.connection
      .prepare(
        `INSERT INTO ai_activity (at, request, understanding, outcome, action_count, detail)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(Date.now(), request, understanding, outcome, actionCount, detail)
  }

  listActivity(limit: number): Array<{
    id: number
    at: number
    request: string
    understanding: string
    outcome: string
    actionCount: number
    detail: string
  }> {
    const rows = this.db.connection
      .prepare('SELECT * FROM ai_activity ORDER BY at DESC LIMIT ?')
      .all(limit) as Array<{
      id: number
      at: number
      request: string
      understanding: string
      outcome: string
      action_count: number
      detail: string
    }>
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      request: row.request,
      understanding: row.understanding,
      outcome: row.outcome,
      actionCount: row.action_count,
      detail: row.detail
    }))
  }
}
