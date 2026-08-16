import type { ProtectionMode } from '@shared/types/shield'

/**
 * Decides whether a `window.open` is the user's doing or the page's.
 *
 * Pure and fact-driven, like `ResourcePolicyEngine` — every judgement here is
 * one a user will eventually disagree with, so each has to be reproducible in a
 * test rather than inferred from a live browser.
 *
 * The signal that makes this possible is a *trusted user gesture* timestamp
 * reported by the content preload. Electron's `setWindowOpenHandler` receives no
 * activation flag, so without that signal a browser cannot distinguish the popup
 * you asked for from the one the page opened while you were reading. The preload
 * reports only that a trusted click or keypress happened — no coordinates, no
 * target, no content.
 */

/**
 * How long after a click a popup can still claim to be that click's doing.
 *
 * Chromium's own transient activation lasts five seconds, which is far more
 * generous than a genuine click→`window.open` needs — real ones fire in tens of
 * milliseconds. A shorter window here catches the pattern where a page banks a
 * click and spends it on a popup seconds later, while leaving ample room for a
 * handler that does real work first.
 */
export const GESTURE_WINDOW_MS = 1500

export interface PopupFacts {
  readonly targetHost: string
  readonly pageHost: string
  /** Milliseconds since the last trusted gesture, or null if there has been none. */
  readonly msSinceGesture: number | null
  /** Windows this page has already opened attributed to the same gesture. */
  readonly opensFromThisGesture: number
  readonly mode: ProtectionMode
  /** The user chose "always allow popups" for this site. */
  readonly siteAllowsPopups: boolean
  /** "Stay on This Site" is on for this tab. */
  readonly siteLocked: boolean
  readonly isCrossSite: boolean
}

export type PopupReason =
  | 'site-allows-popups'
  | 'user-gesture'
  | 'no-user-gesture'
  | 'repeated-from-one-gesture'
  | 'site-locked'
  | 'cross-site-strict'

export interface PopupVerdict {
  readonly action: 'allow' | 'block'
  readonly reason: PopupReason
}

/** Plain-language explanation, shown in the blocked-popup notice. */
export function explainPopup(reason: PopupReason): string {
  switch (reason) {
    case 'site-allows-popups':
      return 'You allow popups on this site.'
    case 'user-gesture':
      return 'You clicked something that opened this.'
    case 'no-user-gesture':
      return 'This site opened a window on its own, not from anything you clicked.'
    case 'repeated-from-one-gesture':
      return 'This site tried to open more than one window from a single click.'
    case 'site-locked':
      return 'Stay on This Site is on for this tab.'
    case 'cross-site-strict':
      return 'Strict mode blocks windows to other sites that you did not ask for.'
  }
}

export function decidePopup(facts: PopupFacts): PopupVerdict {
  // Site lock is per-tab, explicit, and visible in the UI while it is on. It
  // outranks a standing popup exception because it is the more recent and more
  // specific instruction — and it only ever restricts *cross-site* windows, so
  // a site's own popups keep working.
  if (facts.siteLocked && facts.isCrossSite) {
    return { action: 'block', reason: 'site-locked' }
  }

  if (facts.siteAllowsPopups) {
    return { action: 'allow', reason: 'site-allows-popups' }
  }

  const gestured = facts.msSinceGesture !== null && facts.msSinceGesture <= GESTURE_WINDOW_MS
  if (!gestured) {
    return { action: 'block', reason: 'no-user-gesture' }
  }

  // One click, one window. The second window attributed to the same click is the
  // pop-under pattern: the wanted page opens, and something else rides along.
  if (facts.opensFromThisGesture >= 1) {
    return { action: 'block', reason: 'repeated-from-one-gesture' }
  }

  if (facts.mode === 'strict' && facts.isCrossSite) {
    return { action: 'block', reason: 'cross-site-strict' }
  }

  return { action: 'allow', reason: 'user-gesture' }
}
