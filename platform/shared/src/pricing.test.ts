import { describe, it, expect } from 'vitest'
import {
  MS_PER_HOUR,
  formatCents,
  quote,
  scheduleProblems,
  wholeHoursIn,
  type Tier
} from './pricing'

const tier: Tier = {
  placementTier: 'home_banner',
  displayName: 'Start page tile',
  hourlyRateCents: 250,
  minHours: 24,
  maxConcurrent: 6,
  active: true
}

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0)
const at = (hoursFromNow: number): number => NOW + hoursFromNow * MS_PER_HOUR

describe('wholeHoursIn', () => {
  it('counts a whole-hour window', () => {
    expect(wholeHoursIn({ startsAt: at(24), endsAt: at(48) })).toBe(24)
  })

  it('refuses a partial hour', () => {
    // Whole hours are what keeps the quoted price and the charged price
    // identical by construction: neither side ever rounds.
    expect(wholeHoursIn({ startsAt: at(24), endsAt: at(24) + 90 * 60_000 })).toBeNull()
  })

  it('refuses a zero-length or inverted window', () => {
    expect(wholeHoursIn({ startsAt: at(24), endsAt: at(24) })).toBeNull()
    expect(wholeHoursIn({ startsAt: at(48), endsAt: at(24) })).toBeNull()
  })
})

describe('quote', () => {
  it('multiplies whole hours by the tier rate, in cents', () => {
    expect(quote(tier, { startsAt: at(24), endsAt: at(48) })).toEqual({
      hours: 24,
      totalCents: 6000
    })
  })

  it('never produces a fractional cent', () => {
    // The database stores numeric(10,2) and Stripe charges integer cents. A
    // quote that cannot be represented in either is a quote that will be
    // charged as something else.
    const q = quote({ ...tier, hourlyRateCents: 333 }, { startsAt: at(24), endsAt: at(31) })
    expect(q?.totalCents).toBe(2331)
    expect(Number.isInteger(q?.totalCents)).toBe(true)
  })

  it('returns null rather than a wrong number for an unbuyable window', () => {
    expect(quote(tier, { startsAt: at(24), endsAt: at(24) + 1000 })).toBeNull()
  })
})

describe('scheduleProblems', () => {
  const ok = { startsAt: at(24), endsAt: at(48) }

  it('accepts a well-formed booking', () => {
    expect(scheduleProblems(tier, ok, NOW, 12)).toEqual([])
  })

  it('refuses a block below the tier minimum', () => {
    const problems = scheduleProblems(tier, { startsAt: at(24), endsAt: at(30) }, NOW, 12)
    expect(problems.map((p) => p.code)).toContain('below-minimum')
  })

  it('refuses a start inside the lead time', () => {
    // A batch is fetched every six hours, so an advert starting in two would
    // miss most of the readers it was sold to. Refused at the point of sale
    // rather than delivered badly and argued about later.
    const problems = scheduleProblems(tier, { startsAt: at(2), endsAt: at(48) }, NOW, 12)
    expect(problems.map((p) => p.code)).toContain('too-soon')
  })

  it('refuses a start in the past', () => {
    const problems = scheduleProblems(tier, { startsAt: at(-5), endsAt: at(48) }, NOW, 12)
    expect(problems.map((p) => p.code)).toContain('too-soon')
  })

  it('reports every problem at once, not one per attempt', () => {
    // A form that reveals one problem per submission teaches people to guess.
    const problems = scheduleProblems(tier, { startsAt: at(1), endsAt: at(3) }, NOW, 12)
    expect(problems.map((p) => p.code).sort()).toEqual(['below-minimum', 'too-soon'])
  })

  it('stops after an inverted window instead of piling on', () => {
    // Everything downstream would be nonsense, so saying so once is the honest
    // answer.
    const problems = scheduleProblems(tier, { startsAt: at(48), endsAt: at(24) }, NOW, 12)
    expect(problems.map((p) => p.code)).toEqual(['window-inverted'])
  })

  it('refuses a tier that is not on sale', () => {
    const problems = scheduleProblems({ ...tier, active: false }, ok, NOW, 12)
    expect(problems.map((p) => p.code)).toContain('tier-closed')
  })
})

describe('formatCents', () => {
  it('renders whole and part dollars', () => {
    expect(formatCents(6000)).toBe('$60.00')
    expect(formatCents(2331)).toBe('$23.31')
    expect(formatCents(0)).toBe('$0.00')
  })
})
