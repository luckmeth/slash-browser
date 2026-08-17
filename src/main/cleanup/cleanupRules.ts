import type { CleanupMode } from '@shared/types/cleanup'

/**
 * What each cleanup mode hides, and what it must never hide.
 *
 * Pure and data-driven so the rules can be read and tested without a browser.
 * The interesting half is `PRESERVE`: a cleanup that removes the article, the
 * video or the checkout button has not cleaned the page, it has broken it — and
 * that failure is far more damaging than leaving a newsletter overlay up.
 */

/**
 * Never hidden, at any mode.
 *
 * Checked as ancestors too, so a sticky element *inside* an article is left
 * alone. Heuristics fire on shape rather than intent, and the shape of a
 * newsletter bar and the shape of a page's own toolbar are the same.
 */
export const PRESERVE_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '[role="navigation"]',
  'nav',
  'header',
  'video',
  'audio',
  'form',
  'table',
  '#content',
  '#main',
  '.content',
  '.article',
  '.post'
] as const

/** Overlays and modal blockers. Hidden at every mode. */
const OVERLAY_SELECTORS = [
  '[class*="modal" i]:not(form):not([class*="modal-body" i])',
  '[class*="overlay" i]',
  '[class*="popup" i]',
  '[class*="lightbox" i]',
  '[id*="overlay" i]',
  '[id*="popup" i]',
  '[aria-modal="true"]',
  'dialog[open]'
] as const

/** Consent walls, newsletter prompts, sticky bars, chat widgets. */
const INTERRUPTION_SELECTORS = [
  '[class*="cookie" i]',
  '[class*="consent" i]',
  '[class*="gdpr" i]',
  '[id*="cookie" i]',
  '[id*="consent" i]',
  '[class*="newsletter" i]',
  '[class*="subscribe" i]',
  '[class*="signup-prompt" i]',
  '[class*="paywall" i]',
  '[class*="sticky" i]',
  '[class*="floating" i]',
  '[class*="chat-widget" i]',
  '[class*="livechat" i]',
  '[id*="intercom" i]',
  '[class*="notification-bar" i]',
  '[class*="announcement" i]',
  '[class*="back-to-top" i]'
] as const

/** Advertising-shaped elements. Aggressive only. */
const AD_SELECTORS = [
  '[class*="advert" i]',
  '[class*="-ad-" i]',
  '[class*="ad-slot" i]',
  '[class*="adbox" i]',
  '[id*="google_ads" i]',
  '[class*="sponsor" i]',
  '[class*="promo" i]',
  '[class*="banner" i]',
  '[data-ad-slot]',
  'ins.adsbygoogle',
  'iframe[src*="doubleclick" i]',
  'iframe[src*="googlesyndication" i]'
] as const

export interface CleanupPlan {
  readonly mode: CleanupMode
  /** Selectors to hide, already merged for the mode. */
  readonly selectors: readonly string[]
  /** Whether to pause autoplaying media. */
  readonly pauseMedia: boolean
  /**
   * Whether to hide elements merely because they are fixed-position.
   *
   * Only in aggressive: a fixed element is very often the site's own navigation,
   * and removing that leaves a page you cannot get out of.
   */
  readonly hideFixed: boolean
  /** One sentence describing the mode, shown before the user commits to it. */
  readonly description: string
}

/** The rules for a mode. */
export function planCleanup(mode: CleanupMode): CleanupPlan {
  switch (mode) {
    case 'light':
      return {
        mode,
        selectors: [...OVERLAY_SELECTORS],
        pauseMedia: false,
        hideFixed: false,
        description: 'Hides overlays and modal boxes, and releases a locked page so it scrolls again.'
      }
    case 'balanced':
      return {
        mode,
        selectors: [...OVERLAY_SELECTORS, ...INTERRUPTION_SELECTORS],
        pauseMedia: false,
        hideFixed: false,
        description:
          'Also hides cookie and newsletter prompts, sticky bars and floating chat widgets.'
      }
    case 'aggressive':
      return {
        mode,
        selectors: [...OVERLAY_SELECTORS, ...INTERRUPTION_SELECTORS, ...AD_SELECTORS],
        pauseMedia: true,
        hideFixed: true,
        description:
          'Also hides advertising-shaped blocks and anything pinned to the screen, and pauses autoplaying media. Most likely to remove something you wanted — use Restore if it does.'
      }
  }
}

/**
 * Whether cleanup should run on a host.
 *
 * A per-site opt-out is essential: heuristics fire on shape, so there will always
 * be a site where "sticky" is the name of the thing you actually need. Matching
 * is on the exact host — a wildcard would be surprising in the other direction.
 */
export function isDisabledForHost(host: string, disabled: readonly string[]): boolean {
  const normalised = host.toLowerCase().replace(/^www\./, '')
  return disabled.some((entry) => entry.toLowerCase().replace(/^www\./, '') === normalised)
}

/** Adds or removes a host from the opt-out list, without duplicates. */
export function toggleHost(host: string, disabled: readonly string[]): string[] {
  const normalised = host.toLowerCase().replace(/^www\./, '')
  if (normalised === '') return [...disabled]
  return isDisabledForHost(normalised, disabled)
    ? disabled.filter((entry) => entry.toLowerCase().replace(/^www\./, '') !== normalised)
    : [...disabled, normalised]
}

/**
 * A sentence describing what a run actually did.
 *
 * Zero hidden elements is reported as such rather than as success. "Cleaned" on a
 * page where nothing changed teaches the user that the button lies.
 */
export function describeResult(hidden: number, paused: number, scrollUnlocked: boolean): string {
  if (hidden === 0 && paused === 0 && !scrollUnlocked) {
    return 'Nothing to clean — no overlays or interruptions were found on this page.'
  }
  const parts: string[] = []
  if (hidden > 0) parts.push(`Hid ${hidden} element${hidden === 1 ? '' : 's'}`)
  if (paused > 0) parts.push(`paused ${paused} media element${paused === 1 ? '' : 's'}`)
  if (scrollUnlocked) parts.push('released the locked page so it scrolls')
  return `${parts.join(', ')}. Reload the page to put everything back.`
}
