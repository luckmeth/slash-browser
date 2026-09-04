/**
 * Slash Shield — types for the ad, tracker, popup and redirect protection layer.
 *
 * Kept in `shared` so the main-process engines and the renderer dashboard agree
 * on one vocabulary. Every count the dashboard shows is derived from a recorded
 * decision of one of these kinds — there is no separate estimate path.
 */

/** What a blocked thing was blocked as. */
export type ShieldCategory = 'ad' | 'tracker' | 'malicious' | 'popup' | 'redirect'

/**
 * How aggressively to act on signals that are suspicious but not conclusive.
 *
 * Only affects the judgement calls — a request matching a filter rule is blocked
 * in both modes. Strict additionally blocks script-initiated cross-site
 * navigation and popups that standard mode would allow through.
 */
export type ProtectionMode = 'standard' | 'strict'

export interface ShieldCounts {
  ads: number
  trackers: number
  popups: number
  redirects: number
}

export const EMPTY_COUNTS: ShieldCounts = { ads: 0, trackers: 0, popups: 0, redirects: 0 }

/**
 * One recorded protection decision.
 *
 * **Hosts, never full URLs.** A blocked request's path and query string can
 * carry identifiers, session tokens and search terms, and this log is written to
 * disk and shown in a panel. The host is what makes the entry meaningful to a
 * person reading it; the rest is only risk. This is why the dashboard says
 * "doubleclick.net" and not the tracking URL.
 */
export interface ShieldActivityEntry {
  readonly id: string
  readonly at: number
  readonly category: ShieldCategory
  /** Host of the thing that was blocked. */
  readonly host: string
  /** Host of the page it happened on. */
  readonly pageHost: string
}

/** Per-site protection state, as the dashboard renders it. */
export interface SiteShieldState {
  readonly pageHost: string
  readonly enabled: boolean
  readonly counts: ShieldCounts
  /** Popups allowed for this site until the browser restarts. */
  readonly popupsAllowed: boolean
  /** "Stay on This Site" is active for the current tab. */
  readonly siteLocked: boolean
}

/** A popup Slash Shield stopped, held so the user can still let it through. */
export interface HeldPopup {
  readonly id: string
  readonly url: string
  readonly host: string
  readonly pageHost: string
  readonly at: number
}
