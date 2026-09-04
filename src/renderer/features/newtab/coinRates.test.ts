import { describe, expect, it } from 'vitest'
import { hoursPerCoin } from './coinRates'

describe('hoursPerCoin', () => {
  it('reads in minutes at the default rate', () => {
    // 10 coins an hour is the shipped default: one coin every six minutes.
    expect(hoursPerCoin(10)).toBe('6 minutes')
  })

  it('says one hour when the rate is one an hour', () => {
    expect(hoursPerCoin(1)).toBe('1 hours')
  })

  it('switches to hours below one coin an hour', () => {
    expect(hoursPerCoin(0.5)).toBe('2 hours')
    expect(hoursPerCoin(0.4)).toBe('2.5 hours')
  })

  it('switches to seconds above sixty coins an hour', () => {
    expect(hoursPerCoin(120)).toBe('30 seconds')
    expect(hoursPerCoin(3600)).toBe('1 seconds')
  })

  it('keeps one decimal where the number is not whole', () => {
    expect(hoursPerCoin(7)).toBe('8.6 minutes')
  })

  it('makes no claim for a rate that has not been set', () => {
    // The page shows "Pending" in this state; a dash here is the belt and
    // braces for a rate that arrives as zero or nonsense rather than absent.
    expect(hoursPerCoin(0)).toBe('—')
    expect(hoursPerCoin(-5)).toBe('—')
    expect(hoursPerCoin(Number.NaN)).toBe('—')
    expect(hoursPerCoin(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
