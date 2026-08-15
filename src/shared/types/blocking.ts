import { z } from 'zod'

/**
 * Shield state for the active tab.
 *
 * Deliberately named around *what it does* — blocking requests and refusing
 * known-bad domains — rather than "protection" or "security", which would imply
 * guarantees a browser cannot make.
 */
export const BlockingStatusSchema = z.object({
  /** Requests cancelled on this page since it loaded. */
  blockedOnPage: z.number().int(),
  /** Global switches. */
  adsEnabled: z.boolean(),
  maliciousEnabled: z.boolean(),
  /** Host of the current page, for the per-site toggle. */
  host: z.string(),
  /** Whether the user has exempted this site. */
  siteAllowed: z.boolean(),
  /** Size of the loaded lists, so the UI can be honest about coverage. */
  ruleCount: z.number().int(),
  maliciousRuleCount: z.number().int()
})
export type BlockingStatus = z.infer<typeof BlockingStatusSchema>

/** Details of a navigation refused as malicious. */
export const BlockedPageSchema = z.object({
  url: z.string(),
  host: z.string()
})
export type BlockedPage = z.infer<typeof BlockedPageSchema>
