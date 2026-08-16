import type { HeldPopup, ProtectionMode } from '@shared/types/shield'
import { hostOf } from '@shared/url'
import { createLogger } from '../logger'
import { decidePopup, GESTURE_WINDOW_MS, explainPopup, type PopupVerdict } from './PopupPolicy'
import { GestureTracker } from './GestureTracker'

const log = createLogger('shield')

/**
 * The stateful half of popup blocking: remembers gestures, counts windows
 * against them, and holds what it blocked.
 *
 * The decision itself lives in `PopupPolicy` as a pure function. This class owns
 * only the bookkeeping that a pure function cannot: which tab clicked when, and
 * how many windows a single click has already produced.
 *
 * **Nothing blocked is silently dropped.** A popup blocker that guesses wrong
 * and says nothing is indistinguishable from a broken link, so every block is
 * held with its URL and surfaced, and the user can let it through.
 */

/** Held popups are dropped after this long — a stale one is just clutter. */
const HOLD_TTL_MS = 60_000
const MAX_HELD = 10

export interface PopupGuardHooks {
  /** A popup was blocked and is being held for the user. */
  onPopupBlocked: (webContentsId: number, held: HeldPopup, explanation: string) => void
  /** Open a URL the user chose to let through. */
  openInNewTab: (url: string, background: boolean) => void
}

export class PopupGuard {
  private readonly held = new Map<string, HeldPopup>()
  /** Sites the user allowed popups on for this run only. */
  private readonly sessionAllowed = new Set<string>()
  private sequence = 0

  constructor(
    private hooks: PopupGuardHooks,
    private readonly gestures: GestureTracker = new GestureTracker(),
    private readonly now: () => number = () => Date.now()
  ) {}

  setHooks(hooks: PopupGuardHooks): void {
    this.hooks = hooks
  }

  /** Called when the content preload reports a trusted click or keypress. */
  noteGesture(webContentsId: number): void {
    this.gestures.note(webContentsId)
  }

  forget(webContentsId: number): void {
    this.gestures.forget(webContentsId)
  }

  allowPopupsFor(pageHost: string): void {
    this.sessionAllowed.add(pageHost.toLowerCase().replace(/^www\./, ''))
  }

  isPopupAllowedFor(pageHost: string): boolean {
    return this.sessionAllowed.has(pageHost.toLowerCase().replace(/^www\./, ''))
  }

  /**
   * Lets a held popup through.
   *
   * The URL comes from our own held record, never from the caller — the
   * renderer sends an id, so a compromised chrome view cannot turn this into
   * "open any URL I name".
   */
  releaseHeld(id: string): boolean {
    const popup = this.held.get(id)
    if (!popup) return false
    this.held.delete(id)
    this.hooks.openInNewTab(popup.url, false)
    return true
  }

  heldFor(pageHost: string): readonly HeldPopup[] {
    this.pruneHeld()
    return [...this.held.values()].filter((p) => p.pageHost === pageHost)
  }

  /**
   * Decides a `window.open`, recording the outcome.
   *
   * Returns the verdict so the caller can allow or deny; the caller is
   * `NavigationGuards`, which already owns the window-open handler.
   */
  evaluate(input: {
    webContentsId: number
    targetUrl: string
    pageUrl: string
    mode: ProtectionMode
    siteLocked: boolean
  }): PopupVerdict {
    const targetHost = hostOf(input.targetUrl)
    const pageHost = hostOf(input.pageUrl)
    const msSinceGesture = this.gestures.msSince(input.webContentsId)

    const verdict = decidePopup({
      targetHost,
      pageHost,
      msSinceGesture,
      opensFromThisGesture: this.gestures.spentFor(input.webContentsId),
      mode: input.mode,
      siteAllowsPopups: this.isPopupAllowedFor(pageHost),
      siteLocked: input.siteLocked,
      isCrossSite: !isSameSite(targetHost, pageHost)
    })

    if (verdict.action === 'allow') {
      // Spend the gesture, so the *second* window from one click is caught.
      if (msSinceGesture !== null && msSinceGesture <= GESTURE_WINDOW_MS) {
        this.gestures.spend(input.webContentsId)
      }
      return verdict
    }

    this.sequence += 1
    const popup: HeldPopup = {
      id: `hp-${this.sequence}`,
      url: input.targetUrl,
      host: targetHost,
      pageHost,
      at: this.now()
    }
    this.held.set(popup.id, popup)
    this.pruneHeld()

    log.info(`popup blocked on ${pageHost} → ${targetHost} (${verdict.reason})`)
    this.hooks.onPopupBlocked(input.webContentsId, popup, explainPopup(verdict.reason))
    return verdict
  }

  private pruneHeld(): void {
    const cutoff = this.now() - HOLD_TTL_MS
    for (const [id, popup] of this.held) {
      if (popup.at < cutoff) this.held.delete(id)
    }
    while (this.held.size > MAX_HELD) {
      const oldest = this.held.keys().next().value
      if (oldest === undefined) break
      this.held.delete(oldest)
    }
  }
}

/** Same approximate same-site test the filter engine uses; see the note there. */
function isSameSite(a: string, b: string): boolean {
  if (a === b) return true
  const tail = (host: string): string => host.split('.').slice(-2).join('.')
  return tail(a) === tail(b)
}
