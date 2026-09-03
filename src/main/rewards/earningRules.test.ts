import { describe, expect, it } from 'vitest'
import {
  advance,
  blockersFor,
  close,
  explain,
  qualifies,
  DEFAULT_DAILY_CAP_SECONDS,
  IDLE_THRESHOLD_SECONDS,
  MAX_SAMPLE_GAP_MS,
  MIN_INTERVAL_SECONDS,
  type EarningInputs,
  type IntervalState
} from './earningRules'

const earning: EarningInputs = {
  enabled: true,
  earningActive: true,
  signedIn: true,
  focused: true,
  idleSeconds: 0,
  url: 'https://example.com/article',
  privateWindow: false,
  secondsEarnedToday: 0,
  dailyCapSeconds: DEFAULT_DAILY_CAP_SECONDS
}

describe('blockersFor', () => {
  it('earns on an ordinary focused page', () => {
    expect(blockersFor(earning)).toEqual([])
    expect(qualifies(earning)).toBe(true)
  })

  it('does not earn while switched off, however good everything else is', () => {
    expect(blockersFor({ ...earning, enabled: false })).toContain('rewards-off')
  })

  it('does not earn signed out', () => {
    expect(blockersFor({ ...earning, signedIn: false })).toContain('signed-out')
  })

  it('does not earn while the scheme is paused', () => {
    expect(blockersFor({ ...earning, earningActive: false })).toContain('paused')
  })

  it('says the scheme is paused ahead of any local reason it could fix', () => {
    // Signing in earns nothing while earning is off, so offering that first
    // would be advice that cannot work.
    const paused = blockersFor({ ...earning, earningActive: false, signedIn: false })
    expect(paused.indexOf('paused')).toBeLessThan(paused.indexOf('signed-out'))
    expect(explain(paused)).toContain('paused by Slash')
  })

  it('still puts the browser switch first, which is the one the user can reach', () => {
    const off = blockersFor({ ...earning, enabled: false, earningActive: false })
    expect(off[0]).toBe('rewards-off')
  })

  it('does not earn while another application has the foreground', () => {
    expect(blockersFor({ ...earning, focused: false })).toContain('unfocused')
  })

  it('does not earn once the machine has been idle', () => {
    expect(blockersFor({ ...earning, idleSeconds: IDLE_THRESHOLD_SECONDS })).toContain('idle')
    expect(blockersFor({ ...earning, idleSeconds: IDLE_THRESHOLD_SECONDS - 1 })).toEqual([])
  })

  it('does not earn in a private window', () => {
    // Earning would mean reporting that the browsing happened, which is the
    // one thing private mode promises not to do.
    expect(blockersFor({ ...earning, privateWindow: true })).toContain('private-window')
  })

  it.each([
    'slash://newtab',
    'slash://settings',
    'about:blank',
    'chrome://gpu',
    'devtools://devtools/x',
    'file:///c:/tmp/a.html',
    'data:text/html,hi',
    '',
    '   '
  ])('does not earn on the internal page %j', (url) => {
    expect(blockersFor({ ...earning, url })).toContain('internal-page')
  })

  it('is not fooled by capitalisation', () => {
    expect(blockersFor({ ...earning, url: 'SLASH://NewTab' })).toContain('internal-page')
  })

  it('stops at the daily cap', () => {
    expect(blockersFor({ ...earning, secondsEarnedToday: DEFAULT_DAILY_CAP_SECONDS })).toContain(
      'daily-cap'
    )
    expect(
      blockersFor({ ...earning, secondsEarnedToday: DEFAULT_DAILY_CAP_SECONDS - 1 })
    ).toEqual([])
  })

  it('reports every reason at once rather than only the first', () => {
    const blockers = blockersFor({
      ...earning,
      signedIn: false,
      focused: false,
      idleSeconds: 9999,
      url: 'slash://newtab'
    })
    expect(blockers).toEqual(
      expect.arrayContaining(['signed-out', 'unfocused', 'idle', 'internal-page'])
    )
  })
})

describe('explain', () => {
  it('has a sentence for every blocker', () => {
    const all = [
      'rewards-off',
      'signed-out',
      'unfocused',
      'idle',
      'private-window',
      'internal-page',
      'daily-cap'
    ] as const
    for (const blocker of all) {
      expect(explain([blocker])).not.toBe('')
      expect(explain([blocker])).not.toBe('Earning now.')
    }
    expect(explain([])).toBe('Earning now.')
  })
})

describe('advance', () => {
  const t0 = 1_700_000_000_000

  it('opens an interval on the first qualifying sample', () => {
    const { state, closed } = advance(null, { at: t0, qualifying: true })
    expect(closed).toBeNull()
    expect(state).toEqual({ startedAt: t0, lastSampleAt: t0, accumulatedMs: 0 })
  })

  it('accumulates only the time between consecutive qualifying samples', () => {
    let state: IntervalState | null = null
    for (let i = 0; i <= 4; i++) {
      state = advance(state, { at: t0 + i * 30_000, qualifying: true }).state
    }
    expect(state?.accumulatedMs).toBe(120_000)
    // Four gaps of 30s, not five samples of 30s.
    expect(close(state!)).toEqual({ startedAt: t0, endedAt: t0 + 120_000, seconds: 120 })
  })

  it('closes the interval when qualification lapses', () => {
    let state: IntervalState | null = null
    for (let i = 0; i <= 3; i++) {
      state = advance(state, { at: t0 + i * 30_000, qualifying: true }).state
    }
    const result = advance(state, { at: t0 + 120_000, qualifying: false })
    expect(result.state).toBeNull()
    expect(result.closed).toEqual({ startedAt: t0, endedAt: t0 + 90_000, seconds: 90 })
  })

  it('never claims more seconds than the span it reports', () => {
    // The invariant the server's `claimed_seconds <= span` check depends on.
    let state: IntervalState | null = null
    const gaps = [0, 20_000, 45_000, 10_000, 30_000, 60_000]
    let at = t0
    for (const gap of gaps) {
      at += gap
      state = advance(state, { at, qualifying: true }).state
    }
    const closed = close(state!)!
    expect(closed.seconds).toBeLessThanOrEqual((closed.endedAt - closed.startedAt) / 1000)
  })

  it('does not bank the hours a sleeping laptop spent asleep', () => {
    // The easiest way to farm this with no tooling at all: leave the machine
    // suspended and let a naive timer credit the gap on wake.
    let state: IntervalState | null = advance(null, { at: t0, qualifying: true }).state
    state = advance(state, { at: t0 + 30_000, qualifying: true }).state

    const wake = advance(state, { at: t0 + 8 * 60 * 60 * 1000, qualifying: true })
    // The pre-sleep stretch was only 30s, under the floor, so nothing is
    // banked — and crucially the eight hours are not in the new interval.
    expect(wake.closed).toBeNull()
    expect(wake.state).toEqual({
      startedAt: t0 + 8 * 60 * 60 * 1000,
      lastSampleAt: t0 + 8 * 60 * 60 * 1000,
      accumulatedMs: 0
    })
  })

  it('banks a long stretch before a sleep and starts fresh after it', () => {
    let state: IntervalState | null = null
    for (let i = 0; i <= 10; i++) {
      state = advance(state, { at: t0 + i * 30_000, qualifying: true }).state
    }
    const wake = advance(state, { at: t0 + 300_000 + 8 * 60 * 60 * 1000, qualifying: true })
    expect(wake.closed).toEqual({ startedAt: t0, endedAt: t0 + 300_000, seconds: 300 })
    expect(wake.state?.accumulatedMs).toBe(0)
  })

  it('closes rather than credits when the clock jumps backwards', () => {
    let state: IntervalState | null = null
    for (let i = 0; i <= 10; i++) {
      state = advance(state, { at: t0 + i * 30_000, qualifying: true }).state
    }
    const back = advance(state, { at: t0 - 60 * 60 * 1000, qualifying: true })
    expect(back.closed).toEqual({ startedAt: t0, endedAt: t0 + 300_000, seconds: 300 })
    expect(back.state?.accumulatedMs).toBe(0)
    expect(back.state?.startedAt).toBe(t0 - 60 * 60 * 1000)
  })

  it('treats exactly the maximum gap as continuous and one past it as a break', () => {
    const open = advance(null, { at: t0, qualifying: true }).state
    const atLimit = advance(open, { at: t0 + MAX_SAMPLE_GAP_MS, qualifying: true })
    expect(atLimit.state?.accumulatedMs).toBe(MAX_SAMPLE_GAP_MS)
    expect(atLimit.closed).toBeNull()

    const past = advance(open, { at: t0 + MAX_SAMPLE_GAP_MS + 1, qualifying: true })
    expect(past.state?.accumulatedMs).toBe(0)
  })

  it('discards a stretch too short to be worth a row', () => {
    const state: IntervalState = {
      startedAt: t0,
      lastSampleAt: t0 + (MIN_INTERVAL_SECONDS - 1) * 1000,
      accumulatedMs: (MIN_INTERVAL_SECONDS - 1) * 1000
    }
    expect(close(state)).toBeNull()
  })

  it('keeps a stretch exactly at the floor', () => {
    const state: IntervalState = {
      startedAt: t0,
      lastSampleAt: t0 + MIN_INTERVAL_SECONDS * 1000,
      accumulatedMs: MIN_INTERVAL_SECONDS * 1000
    }
    expect(close(state)?.seconds).toBe(MIN_INTERVAL_SECONDS)
  })

  it('produces intervals that never overlap each other', () => {
    // The server refuses overlapping intervals outright, so a tracker that can
    // emit them would silently lose an honest user's time.
    let state: IntervalState | null = null
    const closedRuns: { startedAt: number; endedAt: number }[] = []
    let at = t0
    for (let i = 0; i < 400; i++) {
      at += 30_000
      const qualifying = i % 37 !== 0
      const result = advance(state, { at, qualifying })
      state = result.state
      if (result.closed) closedRuns.push(result.closed)
    }
    expect(closedRuns.length).toBeGreaterThan(1)
    for (let i = 1; i < closedRuns.length; i++) {
      expect(closedRuns[i]!.startedAt).toBeGreaterThanOrEqual(closedRuns[i - 1]!.endedAt)
    }
  })
})
