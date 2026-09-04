import { z } from 'zod'
import { AiProviderIdSchema } from './aiHub'

/**
 * Multi-AI comparison.
 *
 * Asks several providers the same question and shows the answers side by side,
 * so the user can see where they agree and where they do not — which is far more
 * informative than any single answer presented as fact.
 *
 * **Sending one question to several providers multiplies the disclosure, not
 * just the cost.** The same text reaches three separate companies, each with its
 * own retention policy. So the preview names every recipient before anything is
 * sent, and confirmation is per-request rather than a setting someone turns on
 * once and forgets.
 */

export const AiAnswerSchema = z.object({
  provider: AiProviderIdSchema,
  providerName: z.string(),
  model: z.string(),
  /** Whether this provider runs on the machine. Shown beside every answer. */
  local: z.boolean(),
  state: z.enum(['answered', 'failed']),
  text: z.string(),
  /** Why it failed, in plain language. Empty when it answered. */
  error: z.string(),
  /** Round-trip time, which is itself part of comparing providers. */
  elapsedMs: z.number().int()
})
export type AiAnswer = z.infer<typeof AiAnswerSchema>

export const AiComparisonSchema = z.object({
  question: z.string(),
  askedAt: z.number(),
  answers: z.array(AiAnswerSchema)
})
export type AiComparison = z.infer<typeof AiComparisonSchema>

export const ComparePreviewSchema = z.object({
  /** Exactly what will be sent, verbatim. */
  question: z.string(),
  /** Every recipient, named. */
  recipients: z.array(
    z.object({
      provider: AiProviderIdSchema,
      name: z.string(),
      /**
       * Whether this recipient is **verified** to be on this machine.
       *
       * Derived from the endpoint by `loopbackVerdict`, not from the provider
       * catalogue. A provider catalogued as local can be pointed at a remote
       * box, and this list is a disclosure shown immediately before text is
       * sent — the one place a wrong answer here is most expensive.
       */
      local: z.boolean(),
      /** The host that will be contacted, so it can be named rather than implied. */
      host: z.string()
    })
  ),
  /** How many of the recipients are third parties rather than on-device. */
  cloudCount: z.number().int()
})
export type ComparePreview = z.infer<typeof ComparePreviewSchema>
