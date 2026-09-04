import { z } from 'zod'
import { WORKSPACE_ICONS, DEFAULT_WORKSPACE_ICON } from './workspace'

/**
 * Everything the AI layer is permitted to propose.
 *
 * This union **is** the security boundary. `ActionExecutor` is an exhaustive
 * switch over `kind`, so a capability that is not a variant here is not merely
 * discouraged — it is unreachable. There is no `send-message`, no `purchase`,
 * no `submit-form`, no `change-setting`, no `grant-permission`. A model that
 * asks for one produces a payload that fails to parse.
 *
 * Every variant is also reversible or non-destructive: closing tabs pushes them
 * onto the reopen stack, moving tabs can be moved back. Nothing here deletes
 * user data.
 */
export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('organize-tabs'),
    groups: z.array(
      z.object({
        name: z.string().min(1).max(40),
        tabIds: z.array(z.string()).min(1)
      })
    )
  }),
  z.object({
    kind: z.literal('create-workspace'),
    name: z.string().min(1).max(40),
    // Constrained to the real icon set: the model picks from what exists rather
    // than inventing a name that would render as nothing.
    icon: z.enum(WORKSPACE_ICONS).catch(DEFAULT_WORKSPACE_ICON),
    tabIds: z.array(z.string())
  }),
  z.object({
    kind: z.literal('move-tabs'),
    tabIds: z.array(z.string()).min(1),
    toWorkspaceId: z.string()
  }),
  z.object({
    kind: z.literal('close-tabs'),
    tabIds: z.array(z.string()).min(1),
    reason: z.string().max(200)
  }),
  z.object({
    kind: z.literal('save-tabs'),
    tabIds: z.array(z.string()).min(1),
    toBookmarkFolder: z.string().max(60)
  }),
  z.object({
    kind: z.literal('reading-queue'),
    tabIds: z.array(z.string()).min(1),
    orderedTabIds: z.array(z.string())
  })
])
export type BrowserAction = z.infer<typeof BrowserActionSchema>

/** One line of the preview the user approves. */
export const PreviewLineSchema = z.object({
  text: z.string(),
  /** Tabs this line affects, so the UI can show which ones. */
  tabIds: z.array(z.string()),
  /** True when this line closes or moves something. */
  mutating: z.boolean()
})
export type PreviewLine = z.infer<typeof PreviewLineSchema>

export const ActionPlanSchema = z.object({
  planId: z.string(),
  /** The model's reading of the request, echoed so a misunderstanding is visible. */
  understanding: z.string(),
  actions: z.array(BrowserActionSchema),
  preview: z.array(PreviewLineSchema),
  /** Set when the model declined or the request was outside the action set. */
  refusal: z.string().nullable()
})
export type ActionPlan = z.infer<typeof ActionPlanSchema>

export const AiStatusSchema = z.object({
  /** False until a provider *and* a key are configured. Everything hides. */
  configured: z.boolean(),
  provider: z.enum(['none', 'anthropic', 'openai-compatible']),
  model: z.string(),
  /** Whether page text may be sent, in addition to titles and URLs. */
  mayReadPageContent: z.boolean()
})
export type AiStatus = z.infer<typeof AiStatusSchema>

export const AiActivitySchema = z.object({
  id: z.number().int(),
  at: z.number(),
  request: z.string(),
  understanding: z.string(),
  /** 'proposed' | 'approved' | 'cancelled' | 'executed' | 'failed' | 'undone' */
  outcome: z.string(),
  actionCount: z.number().int(),
  detail: z.string()
})
export type AiActivity = z.infer<typeof AiActivitySchema>

/**
 * Exactly what will be sent to the provider, shown before it is sent.
 *
 * The privacy claim is only meaningful if the user can see it, so the engine
 * builds this and the UI renders it verbatim.
 */
export const EgressPreviewSchema = z.object({
  tabCount: z.number().int(),
  includesPageContent: z.boolean(),
  /** Human-readable summary of every field leaving the machine. */
  lines: z.array(z.string())
})
export type EgressPreview = z.infer<typeof EgressPreviewSchema>
