import { z } from 'zod'

/**
 * Shield state for the active tab.
 *
 * Deliberately named around *what it does* — blocking requests and refusing
 * known-bad domains — rather than "protection" or "security", which would imply
 * guarantees a browser cannot make.
 */
/**
 * One recorded decision, as the activity list renders it.
 *
 * Host only. A blocked request's path and query can carry identifiers, search
 * terms and session tokens; the host is the part that means something to someone
 * reading the list, and the rest is only risk.
 */
export const ShieldActivitySchema = z.object({
  id: z.string(),
  at: z.number(),
  category: z.enum(['ad', 'tracker', 'malicious', 'popup', 'redirect']),
  host: z.string(),
  pageHost: z.string()
})

export const ShieldCountsSchema = z.object({
  ads: z.number().int(),
  trackers: z.number().int(),
  popups: z.number().int(),
  redirects: z.number().int()
})

export const BlockingStatusSchema = z.object({
  /** Requests cancelled on this page since it loaded. */
  blockedOnPage: z.number().int(),
  /** The same total, split by what each thing was blocked as. */
  counts: ShieldCountsSchema,
  /** Global switches. */
  adsEnabled: z.boolean(),
  maliciousEnabled: z.boolean(),
  popupsEnabled: z.boolean(),
  strictMode: z.boolean(),
  /** Host of the current page, for the per-site toggle. */
  host: z.string(),
  /** Whether the user has exempted this site. */
  siteAllowed: z.boolean(),
  /** Popups allowed on this site for the rest of this run. */
  popupsAllowedHere: z.boolean(),
  /** "Stay on This Site" is on for this tab. */
  siteLocked: z.boolean(),
  /** Size of the loaded lists, so the UI can be honest about coverage. */
  ruleCount: z.number().int(),
  maliciousRuleCount: z.number().int(),
  /** Most recent decisions, newest first. */
  recent: z.array(ShieldActivitySchema)
})
export type BlockingStatus = z.infer<typeof BlockingStatusSchema>

/** Details of a navigation refused as malicious. */
export const BlockedPageSchema = z.object({
  url: z.string(),
  host: z.string()
})
export type BlockedPage = z.infer<typeof BlockedPageSchema>

/** A popup Slash Shield held, offered to the user rather than dropped. */
export const HeldPopupSchema = z.object({
  id: z.string(),
  url: z.string(),
  host: z.string(),
  pageHost: z.string(),
  at: z.number()
})

/** Pushed to the chrome view when a popup is blocked. */
export const PopupBlockedSchema = z.object({
  popup: HeldPopupSchema,
  /** Plain-language reason, already resolved for display. */
  explanation: z.string()
})
export type PopupBlocked = z.infer<typeof PopupBlockedSchema>

/**
 * A navigation Slash Shield refused, or flagged and allowed.
 *
 * Carries the destination host and a plain-language reason. The wording never
 * asserts the site is malicious unless a rule said so — a fast redirect chain is
 * a pattern, not evidence, and the copy reflects that difference.
 */
export const NavigationNoticeSchema = z.object({
  host: z.string(),
  explanation: z.string()
})
export type NavigationNotice = z.infer<typeof NavigationNoticeSchema>
