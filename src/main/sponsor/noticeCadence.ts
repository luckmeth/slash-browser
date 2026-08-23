/**
 * When a sponsored notice may appear while somebody is browsing.
 *
 * Pure, and the most important rules in the advertising system, because this is
 * the one format that interrupts. Everything else waits on a new tab; this
 * arrives while a person is doing something else, and the difference between
 * "acceptable" and "uninstall it" is entirely in these numbers.
 *
 * The browser blocks other people's interruptions. Ours has to be rare enough
 * that showing it is not hypocrisy — which is a product constraint before it is
 * a revenue one, and why the caps are conservative rather than tuned upward.
 */

export interface CadenceState {
  /** Unix ms of the last notice shown, or 0. */
  readonly lastShownAt: number
  /** How many have been shown in the current day. */
  readonly shownToday: number
  /** The day `shownToday` counts, as YYYY-MM-DD. */
  readonly day: string
}

export interface CadenceLimits {
  /** Most notices in one day. */
  readonly perDay: number
  /** Quiet time between them. */
  readonly minGapMs: number
  /** How long after launch before the first one. */
  readonly settleMs: number
}

/**
 * Deliberately conservative.
 *
 * Three a day at half an hour apart is roughly what a person will tolerate from
 * software they chose; it is also about a tenth of what an ad network would
 * ask for. Raising these is a decision about what the product is, not a dial to
 * turn when revenue is low.
 */
export const DEFAULT_LIMITS: CadenceLimits = {
  perDay: 3,
  minGapMs: 30 * 60 * 1000,
  // Nobody wants an advert four seconds after opening their browser.
  settleMs: 5 * 60 * 1000
}

export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

export type CadenceVerdict =
  | { show: true }
  | { show: false; reason: 'settling' | 'too-soon' | 'daily-cap' }

/**
 * Whether a notice may be shown now.
 *
 * @param launchedAt when this run of the browser started.
 */
export function mayShowNotice(
  state: CadenceState,
  now: number,
  launchedAt: number,
  limits: CadenceLimits = DEFAULT_LIMITS
): CadenceVerdict {
  if (now - launchedAt < limits.settleMs) return { show: false, reason: 'settling' }

  // A new day resets the count. Compared by date string rather than by elapsed
  // hours so the reset lands at local midnight, which is what "3 a day" means
  // to the person seeing them.
  const today = dayOf(now)
  const shownToday = state.day === today ? state.shownToday : 0

  if (shownToday >= limits.perDay) return { show: false, reason: 'daily-cap' }
  if (state.lastShownAt > 0 && now - state.lastShownAt < limits.minGapMs) {
    return { show: false, reason: 'too-soon' }
  }
  return { show: true }
}

/** The state after showing one. */
export function recordShown(state: CadenceState, now: number): CadenceState {
  const today = dayOf(now)
  return {
    lastShownAt: now,
    shownToday: (state.day === today ? state.shownToday : 0) + 1,
    day: today
  }
}

export const EMPTY_CADENCE: CadenceState = { lastShownAt: 0, shownToday: 0, day: '' }
