/**
 * What a campaign costs, and whether it may be bought at all.
 *
 * This mirrors the `campaigns_apply_pricing` trigger in
 * `supabase/migrations/0002_logic.sql` on purpose. The database is the
 * authority — a price that arrives from a browser is a price somebody can edit
 * — but the buyer needs the number to move as they drag the dates, and a
 * checkout that quotes one figure and charges another is worse than no quote.
 *
 * The two must agree. `pricing.test.ts` pins the cases where they could drift.
 */

/** Money is handled in whole cents. Floats lose half a cent and then argue. */
export type Cents = number

export interface Tier {
  readonly placementTier: string
  readonly displayName: string
  readonly hourlyRateCents: Cents
  readonly minHours: number
  readonly maxConcurrent: number
  readonly active: boolean
}

export interface Window {
  readonly startsAt: number
  readonly endsAt: number
}

export interface Quote {
  readonly hours: number
  readonly totalCents: Cents
}

export const MS_PER_HOUR = 3_600_000

/**
 * Hours in a window, or null if it is not a whole number of them.
 *
 * Campaigns are sold in whole hours. Allowing 90 minutes would mean the cost is
 * a rounded product of two rounded numbers, and the client and the database
 * round at different moments — so the quote and the charge could differ by a
 * cent on some windows and not others. Whole hours makes them identical by
 * construction rather than by testing every case.
 */
export function wholeHoursIn(window: Window): number | null {
  const span = window.endsAt - window.startsAt
  if (!Number.isFinite(span) || span <= 0) return null
  if (span % MS_PER_HOUR !== 0) return null
  return span / MS_PER_HOUR
}

export function quote(tier: Tier, window: Window): Quote | null {
  const hours = wholeHoursIn(window)
  if (hours === null) return null
  return { hours, totalCents: hours * tier.hourlyRateCents }
}

export type ScheduleProblem =
  | { code: 'window-inverted'; message: string }
  | { code: 'not-whole-hours'; message: string }
  | { code: 'below-minimum'; message: string }
  | { code: 'too-soon'; message: string }
  | { code: 'tier-closed'; message: string }

/**
 * Every reason this window cannot be bought, in the order a buyer meets them.
 *
 * Returns all of them rather than the first, so a form can show the whole truth
 * at once instead of revealing one problem per attempt.
 *
 * `minLeadHours` exists because a batch is fetched at most every six hours. An
 * advert starting in twenty minutes would simply not reach most of the readers
 * it was sold to — so it is refused at the point of sale rather than delivered
 * badly and argued about afterwards.
 */
export function scheduleProblems(
  tier: Tier,
  window: Window,
  now: number,
  minLeadHours: number
): ScheduleProblem[] {
  const problems: ScheduleProblem[] = []

  if (!tier.active) {
    problems.push({ code: 'tier-closed', message: `${tier.displayName} is not currently on sale.` })
  }

  if (window.endsAt <= window.startsAt) {
    problems.push({ code: 'window-inverted', message: 'The end must come after the start.' })
    return problems
  }

  const hours = wholeHoursIn(window)
  if (hours === null) {
    problems.push({
      code: 'not-whole-hours',
      message: 'Campaigns run for a whole number of hours.'
    })
  } else if (hours < tier.minHours) {
    problems.push({
      code: 'below-minimum',
      message: `${tier.displayName} is sold in blocks of at least ${tier.minHours} hours.`
    })
  }

  if (window.startsAt - now < minLeadHours * MS_PER_HOUR) {
    problems.push({
      code: 'too-soon',
      message:
        `Campaigns must start at least ${minLeadHours} hours from now. ` +
        'Browsers collect adverts a few hours ahead, so a sooner start would ' +
        'not reach most readers.'
    })
  }

  return problems
}

/** `1234` → `"12.34"`. Formatting only; never arithmetic. */
export function formatCents(cents: Cents, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase()
  }).format(cents / 100)
}
