import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityTracker, type ActivitySample } from './ActivityTracker'
import type { RewardsService } from './RewardsService'
import type { SettingsStore } from '../settings/SettingsStore'
import {
  DEFAULT_DAILY_CAP_SECONDS,
  MIN_INTERVAL_SECONDS,
  SAMPLE_INTERVAL_MS,
  type ClosedInterval
} from './earningRules'

/**
 * The wiring, not the rules — those are `earningRules.test.ts`.
 *
 * Worth its own file because the tracker is where an honest user silently loses
 * time: an interval that is opened and never closed, or one dropped when the
 * feature is switched off, costs somebody hours they actually browsed and
 * produces no error anywhere.
 */

function fakes(overrides: Partial<ActivitySample> = {}): {
  tracker: ActivityTracker
  recorded: ClosedInterval[]
  sample: ActivitySample
  setEnabled: (value: boolean) => void
  setSignedIn: (value: boolean) => void
  setEarningActive: (value: boolean) => void
  setProfileComplete: (value: boolean) => void
  changes: () => number
} {
  const sample: ActivitySample = {
    focused: true,
    url: 'https://example.com/article',
    privateWindow: false,
    idleSeconds: 0,
    ...overrides
  }
  const recorded: ClosedInterval[] = []
  let enabled = true
  let signedIn = true
  let earningActive = true
  let profileComplete = true
  let changes = 0

  const rewards = {
    get signedIn() {
      return signedIn
    },
    get earningActive() {
      return earningActive
    },
    get profileComplete() {
      return profileComplete
    },
    secondsToday: 0,
    dailyCapSeconds: DEFAULT_DAILY_CAP_SECONDS,
    record: (interval: ClosedInterval) => recorded.push(interval),
    report: () => Promise.resolve()
  } as unknown as RewardsService

  const settings = {
    getAll: () => ({ rewardsEnabled: enabled })
  } as unknown as SettingsStore

  const tracker = new ActivityTracker(
    () => sample,
    rewards,
    settings,
    () => {
      changes++
    }
  )

  return {
    tracker,
    recorded,
    sample,
    setEnabled: (value) => {
      enabled = value
    },
    setSignedIn: (value) => {
      signedIn = value
    },
    setEarningActive: (value) => {
      earningActive = value
    },
    setProfileComplete: (value) => {
      profileComplete = value
    },
    changes: () => changes
  }
}

/** Advances past N sampling ticks. */
function tick(times: number): void {
  vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * times)
}

describe('ActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not sample at all while switched off', () => {
    const { tracker, recorded, setEnabled } = fakes()
    setEnabled(false)
    tracker.sync()
    tick(100)
    expect(recorded).toEqual([])
    expect(tracker.earning).toBe(false)
  })

  it('accrues while browsing and reports the stretch when it ends', () => {
    const { tracker, recorded, sample } = fakes()
    tracker.sync()

    tick(10)
    expect(tracker.earning).toBe(true)

    // Switch away; the next sample closes the interval.
    sample.focused = false
    tick(1)

    expect(tracker.earning).toBe(false)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.seconds).toBeGreaterThanOrEqual(MIN_INTERVAL_SECONDS)
    // Never more than the wall-clock span it claims.
    expect(recorded[0]!.seconds).toBeLessThanOrEqual(
      (recorded[0]!.endedAt - recorded[0]!.startedAt) / 1000
    )
  })

  it('banks the open stretch when the feature is switched off', () => {
    // Switching off should not cost somebody the half hour they had earned.
    const { tracker, recorded, setEnabled } = fakes()
    tracker.sync()
    tick(20)
    expect(recorded).toEqual([])

    setEnabled(false)
    tracker.sync()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.seconds).toBeGreaterThan(0)
  })

  it('banks the open stretch on quit', () => {
    const { tracker, recorded } = fakes()
    tracker.sync()
    tick(20)
    tracker.dispose()
    expect(recorded).toHaveLength(1)
  })

  it('records nothing at all while signed out', () => {
    const { tracker, recorded, setSignedIn } = fakes()
    setSignedIn(false)
    tracker.sync()
    tick(50)
    tracker.flush()
    expect(recorded).toEqual([])
    expect(tracker.note).toBe('Sign in to start earning.')
  })

  it('records nothing while the scheme is paused, and says which silence it is', () => {
    // The server refuses the credit anyway, so accruing here would bank time
    // that is going to be thrown away -- and a balance that stops moving with
    // no sentence beside it is the complaint this switch exists to answer.
    const { tracker, recorded, setEarningActive } = fakes()
    setEarningActive(false)
    tracker.sync()
    tick(50)
    tracker.flush()
    expect(recorded).toEqual([])
    expect(tracker.note).toContain('paused by Slash')
  })

  it('earns again the moment the pause lifts', () => {
    const { tracker, recorded, setEarningActive } = fakes()
    setEarningActive(false)
    tracker.sync()
    tick(10)
    setEarningActive(true)
    tick(10)
    tracker.flush()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.seconds).toBeGreaterThan(0)
  })

  it('records nothing until the details are given, then starts', () => {
    const { tracker, recorded, setProfileComplete } = fakes()
    setProfileComplete(false)
    tracker.sync()
    tick(20)
    tracker.flush()
    expect(recorded).toEqual([])
    expect(tracker.note).toContain('unlock collecting')

    setProfileComplete(true)
    tick(20)
    tracker.flush()
    expect(recorded).toHaveLength(1)
  })

  it('records nothing from a private window', () => {
    const { tracker, recorded } = fakes({ privateWindow: true })
    tracker.sync()
    tick(50)
    tracker.flush()
    expect(recorded).toEqual([])
  })

  it('records nothing while an internal page is open', () => {
    const { tracker, recorded } = fakes({ url: 'slash://newtab' })
    tracker.sync()
    tick(50)
    tracker.flush()
    expect(recorded).toEqual([])
  })

  it('pauses on idle and resumes without losing the earlier stretch', () => {
    const { tracker, recorded, sample } = fakes()
    tracker.sync()
    tick(10)

    sample.idleSeconds = 600
    tick(2)
    expect(recorded).toHaveLength(1)
    const first = recorded[0]!

    sample.idleSeconds = 0
    tick(10)
    tracker.flush()

    expect(recorded).toHaveLength(2)
    // The two must not overlap - the server refuses intervals that do, so an
    // overlap here silently costs the user the second stretch.
    expect(recorded[1]!.startedAt).toBeGreaterThanOrEqual(first.endedAt)
  })

  it('discards a stretch too short to be worth reporting', () => {
    const { tracker, recorded, sample } = fakes()
    tracker.sync()
    tick(1)
    sample.focused = false
    tick(1)
    expect(recorded).toEqual([])
  })

  it('tells the renderer when earning starts and stops, not on every tick', () => {
    const { tracker, sample, changes } = fakes()
    tracker.sync()
    tick(1)
    const afterStart = changes()
    tick(20)
    // Twenty quiet ticks must not be twenty broadcasts.
    expect(changes()).toBe(afterStart)

    sample.focused = false
    tick(1)
    expect(changes()).toBeGreaterThan(afterStart)
  })

  it('is safe to sync repeatedly without stacking timers', () => {
    const { tracker, recorded, sample } = fakes()
    tracker.sync()
    tracker.sync()
    tracker.sync()
    tick(10)
    sample.focused = false
    tick(1)
    // One timer, so one interval - not three.
    expect(recorded).toHaveLength(1)
  })
})
