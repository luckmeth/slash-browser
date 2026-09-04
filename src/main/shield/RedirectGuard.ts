import { hostOf } from '@shared/url'
import type { ProtectionMode } from '@shared/types/shield'
import { createLogger } from '../logger'
import type { GestureTracker } from './GestureTracker'
import {
  decideRedirect,
  trimChain,
  explainRedirect,
  type NavigationHop,
  type RedirectVerdict
} from './RedirectChainMonitor'

const log = createLogger('shield')

/**
 * The stateful half of redirect protection: remembers where each tab has been.
 *
 * The judgement lives in `RedirectChainMonitor` as a pure function. This class
 * owns only the chain — which hosts a tab has passed through and when — because
 * that is the part a pure function cannot hold.
 *
 * A note on what this deliberately does not do: it never claims a navigation is
 * malicious. `decideRedirect` returns `warn` for anything supported by a pattern
 * rather than a rule, and a warn is recorded and surfaced but not blocked. The
 * only outright block from a pattern is a jump to a host that is *on a filter
 * list*, which is a rule.
 */
export interface RedirectGuardHooks {
  /** A navigation was refused; the UI explains rather than showing a dead page. */
  onNavigationBlocked: (webContentsId: number, host: string, explanation: string) => void
  /** Something looked wrong but was allowed — recorded for the activity list. */
  onNavigationWarned: (webContentsId: number, host: string, explanation: string) => void
}

export class RedirectGuard {
  private readonly chains = new Map<number, NavigationHop[]>()

  constructor(
    private hooks: RedirectGuardHooks,
    private readonly gestures: GestureTracker,
    private readonly isKnownAdHost: (host: string) => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  setHooks(hooks: RedirectGuardHooks): void {
    this.hooks = hooks
  }

  /** A tab navigated away or closed; its chain no longer means anything. */
  forget(webContentsId: number): void {
    this.chains.delete(webContentsId)
  }

  /**
   * Judges a pending top-level navigation, recording it in the tab's chain.
   *
   * Returns true to allow. Called from `will-navigate` and `will-redirect`,
   * which are the two points at which a navigation can still be stopped.
   */
  evaluate(input: {
    webContentsId: number
    targetUrl: string
    currentUrl: string
    mode: ProtectionMode
    siteLocked: boolean
  }): boolean {
    const targetHost = hostOf(input.targetUrl)
    if (targetHost === '') return true

    const hop: NavigationHop = {
      host: targetHost,
      at: this.now(),
      msSinceGesture: this.gestures.msSince(input.webContentsId)
    }

    const chain = trimChain([...(this.chains.get(input.webContentsId) ?? []), hop])
    this.chains.set(input.webContentsId, chain)

    const verdict: RedirectVerdict = decideRedirect({
      chain,
      mode: input.mode,
      targetIsKnownAd: this.isKnownAdHost(targetHost),
      siteLocked: input.siteLocked,
      isCrossSite: !isSameSite(targetHost, hostOf(input.currentUrl))
    })

    if (verdict.action === 'block') {
      log.info(`navigation blocked → ${targetHost} (${verdict.reason})`)
      this.hooks.onNavigationBlocked(
        input.webContentsId,
        targetHost,
        explainRedirect(verdict.reason)
      )
      // The blocked hop did not happen, so it must not stay in the chain and
      // colour the judgement of the next one.
      this.chains.set(input.webContentsId, chain.slice(0, -1))
      return false
    }

    if (verdict.action === 'warn') {
      log.info(`navigation flagged → ${targetHost} (${verdict.reason})`)
      this.hooks.onNavigationWarned(
        input.webContentsId,
        targetHost,
        explainRedirect(verdict.reason)
      )
    }

    return true
  }
}

/** Same approximate same-site test the filter engine uses; see the note there. */
function isSameSite(a: string, b: string): boolean {
  if (a === b) return true
  if (a === '' || b === '') return false
  const tail = (host: string): string => host.split('.').slice(-2).join('.')
  return tail(a) === tail(b)
}
