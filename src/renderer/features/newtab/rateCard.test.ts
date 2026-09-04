import { describe, expect, it } from 'vitest'
import { lowestRate } from './rateCard'

/**
 * `lowestRate` produces a price claim in the advertise page hero — "from $2.50
 * an hour" — so it is a statement about money derived from strings an operator
 * can change. A wrong answer here undercuts or overstates the rate card
 * immediately below it on the same page, which is the kind of contradiction a
 * buyer notices and a refund follows.
 */
describe('lowestRate', () => {
  it('picks the cheapest of several rates', () => {
    expect(
      lowestRate([
        { rate: '$12 / hour · 24 hour minimum' },
        { rate: '$2.50 / hour · 24 hour minimum' },
        { rate: '$6 / hour · 24 hour minimum' }
      ])
    ).toBe('2.50')
  })

  it('keeps whole numbers whole', () => {
    expect(lowestRate([{ rate: '$4 / hour' }, { rate: '$12 / hour' }])).toBe('4')
  })

  it('is not fooled by the 24 in "24 hour minimum"', () => {
    // The first number in the string is the price; the minimum that follows is
    // not a rate. Matching greedily across the whole string would have made the
    // cheapest placement look like it cost nothing.
    expect(lowestRate([{ rate: '$30 / hour · 24 hour minimum' }])).toBe('30')
  })

  it('ignores an unparseable entry rather than counting it as zero', () => {
    expect(lowestRate([{ rate: 'Contact us' }, { rate: '$6 / hour' }])).toBe('6')
  })

  it('makes no claim when there is nothing to claim', () => {
    expect(lowestRate([])).toBe('—')
    expect(lowestRate([{ rate: 'Enquire' }])).toBe('—')
  })

  it('ignores a zero rate, which would advertise "from $0"', () => {
    expect(lowestRate([{ rate: '$0 / hour' }, { rate: '$4 / hour' }])).toBe('4')
  })
})
