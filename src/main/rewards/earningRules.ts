/**
 * Whether a given moment of browsing earns anything, and how moments become
 * intervals.
 *
 * Pure and clock-injected, in the same spirit as `ResourcePolicyEngine` and
 * `selectStartable`, and for two reasons that both matter here:
 *
 *  1. **Every rule below is a fraud control.** Idle, unfocused, internal page,
 *     private window, daily cap — each one exists because without it a machine
 *     left switched on overnight earns as much as somebody actually using the
 *     browser. Rules that decide who gets paid are worth testing as rules
 *     rather than observing in a running browser.
 *  2. **"Why did I not earn anything for two hours" is otherwise the least
 *     answerable question in the product.** `blockersFor` returns the reasons,
 *     so the rewards screen can say which one applied instead of showing a
 *     number that silently stopped moving.
 *
 * Nothing here is the authority on a balance. The server decides that; this
 * decides only what the browser is willing to *claim*, and the server assumes
 * it is lying anyway.
 */

/** How often the tracker samples. */
export const SAMPLE_INTERVAL_MS = 30_000

/**
 * The largest gap between two samples that still counts as continuous.
 *
 * A longer gap means the timer did not run — the machine slept, the process was
 * suspended, or the clock moved. None of those are browsing, so the open
 * interval is closed at its last known-good sample and a new one begins. Set
 * generously against `SAMPLE_INTERVAL_MS` so an ordinary busy-event-loop delay
 * does not fragment an honest session.
 */
export const MAX_SAMPLE_GAP_MS = 90_000

/**
 * No input for this long is not browsing.
 *
 * `powerMonitor.getSystemIdleTime()` is OS-wide, so this is genuinely "the
 * person left", not "the page stopped animating".
 */
export const IDLE_THRESHOLD_SECONDS = 120

/**
 * Shorter than this is not reported at all.
 *
 * Without a floor, every alt-tab produces a row, and a day of ordinary use
 * becomes hundreds of intervals to store, post and validate — for the same
 * total. It also keeps the server's 500-entry batch limit comfortable.
 */
export const MIN_INTERVAL_SECONDS = 60

/** Matches `coin_config.daily_cap_seconds`, used until the server says otherwise. */
export const DEFAULT_DAILY_CAP_SECONDS = 21_600

export type EarningBlocker =
  | 'signed-out'
  | 'rewards-off'
  | 'paused'
  | 'unfocused'
  | 'idle'
  | 'internal-page'
  | 'private-window'
  | 'daily-cap'

export interface EarningInputs {
  /** Rewards are opt-in; the browser is fully usable without them. */
  enabled: boolean
  /**
   * Whether the scheme itself is running, from the server's own config.
   *
   * **True until the server says otherwise**, including before the first fetch
   * ever happens. "Not yet known" must not read as "paused": one is a browser
   * that has not asked, the other is an operator having switched earning off,
   * and showing the second when the first is true tells somebody their time is
   * being thrown away when it is not.
   */
  earningActive: boolean
  signedIn: boolean
  /** Slash has the foreground window. */
  focused: boolean
  /** From `powerMonitor.getSystemIdleTime()`. */
  idleSeconds: number
  /** The active tab's address. */
  url: string
  privateWindow: boolean
  /** Seconds already banked today, from the server's ledger. */
  secondsEarnedToday: number
  dailyCapSeconds: number
}

/**
 * Every reason this moment does not earn, in the order a person would want to
 * read them. Empty means it does.
 */
export function blockersFor(input: EarningInputs): EarningBlocker[] {
  const blockers: EarningBlocker[] = []
  if (!input.enabled) blockers.push('rewards-off')
  // Ahead of every local reason, because none of them is actionable while the
  // scheme is off: "sign in to start earning" would be a straight lie, since
  // signing in would earn nothing.
  if (!input.earningActive) blockers.push('paused')
  if (!input.signedIn) blockers.push('signed-out')
  if (!input.focused) blockers.push('unfocused')
  if (input.idleSeconds >= IDLE_THRESHOLD_SECONDS) blockers.push('idle')
  // A private window is browsing the user asked not to be recorded. Earning
  // from it would mean reporting that it happened, which is the one thing the
  // mode promises not to do.
  if (input.privateWindow) blockers.push('private-window')
  // The new tab page left open is not browsing, and it is what a machine
  // sitting idle-but-not-idle would show for hours.
  if (isInternalUrl(input.url)) blockers.push('internal-page')
  if (input.secondsEarnedToday >= input.dailyCapSeconds) blockers.push('daily-cap')
  return blockers
}

export function qualifies(input: EarningInputs): boolean {
  return blockersFor(input).length === 0
}

/**
 * Deliberately local rather than imported from `@shared/types/tab`.
 *
 * This module is a fraud boundary and is unit-tested as pure arithmetic; the
 * rule "internal pages do not earn" should not change silently because a URL
 * helper elsewhere gained a case. Anything that is not a real remote page does
 * not earn, and that includes an empty address.
 */
function isInternalUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase()
  if (trimmed === '') return true
  return (
    trimmed.startsWith('slash://') ||
    trimmed.startsWith('about:') ||
    trimmed.startsWith('chrome://') ||
    trimmed.startsWith('devtools://') ||
    trimmed.startsWith('file://') ||
    trimmed.startsWith('data:')
  )
}

/** One closed stretch of qualifying time, ready to report. */
export interface ClosedInterval {
  startedAt: number
  endedAt: number
  seconds: number
}

export interface IntervalState {
  startedAt: number
  lastSampleAt: number
  /** Accumulated qualifying milliseconds, which is not `lastSampleAt - startedAt`. */
  accumulatedMs: number
}

export interface AdvanceResult {
  state: IntervalState | null
  closed: ClosedInterval | null
}

/**
 * Fold one sample into the open interval.
 *
 * The invariant the server depends on: `seconds` never exceeds the wall-clock
 * span between `startedAt` and `endedAt`. Time only accrues between two
 * consecutive samples that were *both* qualifying and close enough together to
 * have actually elapsed, so a suspended laptop cannot bank the hours it spent
 * asleep — which is the single easiest way to farm this without any tooling at
 * all.
 */
export function advance(
  state: IntervalState | null,
  sample: { at: number; qualifying: boolean },
  maxGapMs: number = MAX_SAMPLE_GAP_MS
): AdvanceResult {
  if (!sample.qualifying) {
    return { state: null, closed: state ? close(state) : null }
  }

  if (!state) {
    return { state: { startedAt: sample.at, lastSampleAt: sample.at, accumulatedMs: 0 }, closed: null }
  }

  const delta = sample.at - state.lastSampleAt

  // Clock moved backwards, or the gap is too large to have been spent
  // browsing. Bank what is known good and start again from here; crediting
  // across the discontinuity is exactly the claim that cannot be substantiated.
  if (delta < 0 || delta > maxGapMs) {
    return {
      state: { startedAt: sample.at, lastSampleAt: sample.at, accumulatedMs: 0 },
      closed: close(state)
    }
  }

  return {
    state: {
      startedAt: state.startedAt,
      lastSampleAt: sample.at,
      accumulatedMs: state.accumulatedMs + delta
    },
    closed: null
  }
}

/**
 * Close an interval, or discard it for being too short to be worth a row.
 */
export function close(state: IntervalState): ClosedInterval | null {
  const seconds = Math.floor(state.accumulatedMs / 1000)
  if (seconds < MIN_INTERVAL_SECONDS) return null
  return { startedAt: state.startedAt, endedAt: state.lastSampleAt, seconds }
}

/** The sentence the rewards screen shows when nothing is accruing. */
export function explain(blockers: readonly EarningBlocker[]): string {
  const first = blockers[0]
  if (first === undefined) return 'Earning now.'
  switch (first) {
    case 'rewards-off':
      return 'Slash Coin is switched off.'
    case 'paused':
      return 'Earning is paused by Slash at the moment — nothing is accruing for anyone.'
    case 'signed-out':
      return 'Sign in to start earning.'
    case 'unfocused':
      return 'Paused — Slash is not the active window.'
    case 'idle':
      return 'Paused — no activity on this machine.'
    case 'private-window':
      return 'Private windows do not earn, because nothing about them is reported.'
    case 'internal-page':
      return 'Paused — open a page to earn.'
    case 'daily-cap':
      return "You have reached today's maximum. It resets at midnight UTC."
    default:
      return 'Not earning at the moment.'
  }
}
