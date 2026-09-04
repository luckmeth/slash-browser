import { safeStorage } from 'electron'
import {
  AI_PROVIDER_CATALOGUE,
  DEFAULT_LOCAL_BASE_URL,
  type AiHubStatus,
  type AiProviderId,
  type AiProviderInfo
} from '@shared/types/aiHub'
import { endpointHost, loopbackVerdict } from '@shared/ai/loopback'
import type { Database } from '../db/Database'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAICompatibleProvider,
  type LLMProvider
} from './LLMProvider'

const log = createLogger('ai')

interface CredentialRow {
  provider: string
  api_key: Buffer | null
  model: string
  base_url: string | null
}

/**
 * The AI Hub's provider registry.
 *
 * Owns the catalogue, the per-provider credentials, and the construction of a
 * live `LLMProvider`. Everything above it — the agent, Page Insight, anything
 * added later — asks the registry for "the provider to use" and never learns
 * which vendor answered or what the key was.
 *
 * Three rules this class exists to enforce:
 *
 *  - **A key never leaves the main process.** The hub reports `connected: true`,
 *    never the secret. There is no channel that returns one.
 *  - **No plaintext, ever.** If the OS offers no keychain, connecting is refused.
 *    Falling back to a readable blob beside the browsing history would be worse
 *    than not supporting the provider at all.
 *  - **Each provider keeps its own model.** One global model name is wrong for
 *    every provider but the one it was typed for.
 */
/**
 * The host a cloud provider is contacted on.
 *
 * Hard-coded per provider because these endpoints are fixed by the provider
 * classes in `LLMProvider.ts` and are not user-editable. Naming the host is
 * better than "a third party" — somebody deciding whether to send their
 * browsing history somewhere deserves to be told where.
 */
function hostOfCatalogue(id: AiProviderId): string {
  switch (id) {
    case 'anthropic':
      return 'api.anthropic.com'
    case 'openai':
      return 'api.openai.com'
    case 'google':
      return 'generativelanguage.googleapis.com'
    default:
      return ''
  }
}

export class ProviderRegistry {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsStore
  ) {}

  status(): AiHubStatus {
    const rows = this.rows()
    const defaultProvider = this.resolveDefault(rows)

    const providers: AiProviderInfo[] = AI_PROVIDER_CATALOGUE.map((entry) => {
      const row = rows.get(entry.id)
      const baseUrl = entry.local ? (row?.base_url ?? DEFAULT_LOCAL_BASE_URL) : null
      // Checked, not assumed. `entry.local` says this provider *id* is the
      // OpenAI-compatible one; the endpoint beside it is free text the user can
      // point anywhere, and the UI used to render the id as a promise about the
      // destination. A cloud provider has a fixed remote endpoint by definition.
      const destination = entry.local ? loopbackVerdict(baseUrl) : 'remote'

      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        // A local endpoint needs no key, so "connected" means configured at all.
        connected: entry.requiresKey ? row?.api_key != null : row !== undefined,
        model: row?.model || entry.defaultModel,
        suggestedModels: [...entry.suggestedModels],
        requiresKey: entry.requiresKey,
        baseUrl,
        keyUrl: entry.keyUrl,
        local: entry.local,
        destination,
        destinationHost: entry.local ? endpointHost(baseUrl) : hostOfCatalogue(entry.id)
      }
    })

    return {
      providers,
      defaultProvider,
      secureStorageAvailable: safeStorage.isEncryptionAvailable()
    }
  }

  /**
   * Stores or updates a provider's configuration.
   *
   * @returns why it failed, or null on success. A boolean would not be enough —
   *   "no keychain on this system" and "that provider needs a key" need
   *   different words in the interface.
   */
  connect(input: {
    provider: AiProviderId
    apiKey?: string
    model?: string
    baseUrl?: string
  }): string | null {
    const entry = AI_PROVIDER_CATALOGUE.find((candidate) => candidate.id === input.provider)
    if (!entry) return 'Unknown provider.'

    let encrypted: Buffer | null = null
    if (entry.requiresKey) {
      const key = (input.apiKey ?? '').trim()
      if (key === '') return `${entry.name} needs an API key.`
      if (!safeStorage.isEncryptionAvailable()) {
        return 'This system has no secure credential store, so Slash will not save the key. Storing it in readable form beside your browsing history is not something it will do.'
      }
      encrypted = safeStorage.encryptString(key)
    }

    this.db.connection
      .prepare(
        `INSERT INTO ai_credentials (provider, api_key, model, base_url, created_at)
         VALUES (@provider, @key, @model, @baseUrl, @now)
         ON CONFLICT(provider) DO UPDATE SET
           api_key  = COALESCE(excluded.api_key, ai_credentials.api_key),
           model    = excluded.model,
           base_url = excluded.base_url`
      )
      .run({
        provider: input.provider,
        key: encrypted,
        model: (input.model ?? '').trim() || entry.defaultModel,
        baseUrl: entry.local ? (input.baseUrl ?? DEFAULT_LOCAL_BASE_URL) : null,
        now: Date.now()
      })

    // First provider connected becomes the default, so the AI features light up
    // without a second step the user has no reason to expect.
    if (this.settings.getAll().aiProvider === 'none') {
      this.settings.update({ aiProvider: this.legacyName(input.provider) })
    }
    log.info(`connected AI provider ${input.provider}`)
    return null
  }

  /** Forgets a provider's credentials entirely. */
  disconnect(provider: AiProviderId): void {
    this.db.connection.prepare('DELETE FROM ai_credentials WHERE provider = ?').run(provider)
    const remaining = this.rows()
    const next = this.resolveDefault(remaining)
    this.settings.update({ aiProvider: next ? this.legacyName(next) : 'none' })
    log.info(`disconnected AI provider ${provider}`)
  }

  setDefault(provider: AiProviderId): string | null {
    const info = this.status().providers.find((candidate) => candidate.id === provider)
    if (!info?.connected) return 'Connect that provider first.'
    this.settings.update({ aiProvider: this.legacyName(provider) })
    return null
  }

  /**
   * Builds the provider AI features should use, or null when none is usable.
   *
   * Returning null is the normal state on a fresh install and every caller
   * treats it as "AI is off" — which is what keeps the browser fully functional
   * with no provider configured.
   */
  active(): LLMProvider | null {
    const status = this.status()
    if (!status.defaultProvider) return null
    return this.build(status.defaultProvider)
  }

  /** Builds a specific provider, for asking several the same question. */
  build(provider: AiProviderId): LLMProvider | null {
    const rows = this.rows()
    const row = rows.get(provider)
    const entry = AI_PROVIDER_CATALOGUE.find((candidate) => candidate.id === provider)
    if (!entry) return null

    const model = row?.model || entry.defaultModel
    const key = row?.api_key ? this.decrypt(row.api_key) : null
    if (entry.requiresKey && !key) return null

    switch (provider) {
      case 'anthropic':
        return new AnthropicProvider(key!, model)
      case 'openai':
        return new OpenAICompatibleProvider('https://api.openai.com/v1', key!, model)
      case 'google':
        return new GoogleProvider(key!, model)
      case 'local':
        // Key optional: most local servers ignore it, some proxies require one.
        return new OpenAICompatibleProvider(
          row?.base_url ?? DEFAULT_LOCAL_BASE_URL,
          key ?? '',
          model
        )
    }
  }

  /** Connected providers, for the multi-provider comparison surface. */
  connectedIds(): AiProviderId[] {
    return this.status()
      .providers.filter((provider) => provider.connected)
      .map((provider) => provider.id)
  }

  private rows(): Map<string, CredentialRow> {
    const rows = this.db.connection
      .prepare('SELECT provider, api_key, model, base_url FROM ai_credentials')
      .all() as CredentialRow[]
    return new Map(rows.map((row) => [row.provider, row]))
  }

  /**
   * Which provider is the default.
   *
   * Prefers the stored setting when that provider is still connected, and
   * otherwise falls back to any connected one — so deleting the default's key
   * does not leave AI features pointing at a provider that cannot answer.
   */
  private resolveDefault(rows: Map<string, CredentialRow>): AiProviderId | null {
    const usable = AI_PROVIDER_CATALOGUE.filter((entry) => {
      const row = rows.get(entry.id)
      return entry.requiresKey ? row?.api_key != null : row !== undefined
    }).map((entry) => entry.id)

    if (usable.length === 0) return null
    const configured = this.settings.getAll().aiProvider
    const matching = usable.find((id) => this.legacyName(id) === configured)
    return matching ?? usable[0]!
  }

  private decrypt(blob: Buffer): string | null {
    try {
      return safeStorage.decryptString(blob)
    } catch (error) {
      // A key encrypted under a different Windows account cannot be read here.
      // Treated as absent rather than fatal: the user reconnects.
      log.warn('stored provider key could not be decrypted', error)
      return null
    }
  }

  /**
   * Maps a hub provider id onto the older `aiProvider` setting.
   *
   * That setting predates the hub and its enum is part of the persisted settings
   * schema, so it is kept as the record of "which provider is default" rather
   * than migrated — three of the four ids map onto its `openai-compatible` case.
   */
  private legacyName(provider: AiProviderId): 'anthropic' | 'openai-compatible' {
    return provider === 'anthropic' ? 'anthropic' : 'openai-compatible'
  }
}
