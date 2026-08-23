import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LIMITS,
  EMPTY_CADENCE,
  dayOf,
  mayShowNotice,
  recordShown,
  type CadenceState
} from './noticeCadence'

const NOON = Date.UTC(2026, 7, 23, 12, 0, 0)
const MINUTE = 60_000
const launched = NOON - 60 * MINUTE

describe('mayShowNotice', () => {
  it('says nothing for the first few minutes after launch', () => {
    // Nobody wants an advert four seconds after opening their browser.
    expect(mayShowNotice(EMPTY_CADENCE, NOON, NOON)).toEqual({ show: false, reason: 'settling' })
    expect(mayShowNotice(EMPTY_CADENCE, NOON, NOON - 4 * MINUTE)).toEqual({
      show: false,
      reason: 'settling'
    })
  })

  it('allows the first one once the browser has settled', () => {
    expect(mayShowNotice(EMPTY_CADENCE, NOON, launched)).toEqual({ show: true })
  })

  it('keeps a quiet gap between notices', () => {
    const state: CadenceState = { lastShownAt: NOON - 10 * MINUTE, shownToday: 1, day: dayOf(NOON) }
    expect(mayShowNotice(state, NOON, launched)).toEqual({ show: false, reason: 'too-soon' })
    expect(mayShowNotice(state, NOON + 21 * MINUTE, launched)).toEqual({ show: true })
  })

  it('stops at the daily cap', () => {
    const state: CadenceState = {
      lastShownAt: NOON - 60 * MINUTE,
      shownToday: DEFAULT_LIMITS.perDay,
      day: dayOf(NOON)
    }
    expect(mayShowNotice(state, NOON, launched)).toEqual({ show: false, reason: 'daily-cap' })
  })

  it('resets the count on a new day, not after 24 hours', () => {
    // "Three a day" has to mean what the person seeing them thinks it means,
    // which is three between one midnight and the next.
    const yesterday: CadenceState = {
      lastShownAt: NOON - 60 * MINUTE,
      shownToday: DEFAULT_LIMITS.perDay,
      day: '2026-08-22'
    }
    expect(mayShowNotice(yesterday, NOON, launched)).toEqual({ show: true })
  })

  it('never shows more than the cap in one day, however often it is asked', () => {
    let state = EMPTY_CADENCE
    let shown = 0
    // Every 31 minutes for a whole day: the gap never blocks, so only the cap can.
    for (let at = NOON; at < NOON + 24 * 60 * MINUTE; at += 31 * MINUTE) {
      if (mayShowNotice(state, at, launched).show) {
        state = recordShown(state, at)
        shown += 1
      }
    }
    // The window crosses midnight, so one day's cap plus the next day's.
    expect(shown).toBeLessThanOrEqual(DEFAULT_LIMITS.perDay * 2)
    expect(shown).toBeGreaterThanOrEqual(DEFAULT_LIMITS.perDay)
  })
})

describe('recordShown', () => {
  it('counts within the same day', () => {
    const first = recordShown(EMPTY_CADENCE, NOON)
    expect(first).toEqual({ lastShownAt: NOON, shownToday: 1, day: dayOf(NOON) })
    expect(recordShown(first, NOON + MINUTE).shownToday).toBe(2)
  })

  it('starts again on a new day', () => {
    const yesterday: CadenceState = { lastShownAt: NOON, shownToday: 3, day: '2026-08-22' }
    expect(recordShown(yesterday, NOON).shownToday).toBe(1)
  })
})
