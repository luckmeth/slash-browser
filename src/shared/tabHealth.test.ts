import { describe, it, expect } from 'vitest'
import {
  summariseTabHealth,
  formatBytes,
  memoryCaption,
  type HealthTab
} from './tabHealth'

const MB = 1024 * 1024

let nextId = 0
const tab = (over: Partial<HealthTab> = {}): HealthTab => ({
  tabId: `t${(nextId += 1)}`,
  state: 'ACTIVE',
  memoryBytes: 100 * MB,
  measuredSavingsBytes: null,
  blockers: [],
  sharedProcess: false,
  ...over
})

describe('summariseTabHealth', () => {
  it('counts nothing on an empty browser', () => {
    const health = summariseTabHealth([], 0)
    expect(health.total).toBe(0)
    expect(health.sleepableIds).toEqual([])
    expect(health.estimatedOpportunityBytes).toBe(0)
  })

  it('splits tabs by state', () => {
    const health = summariseTabHealth(
      [
        tab({ state: 'ACTIVE' }),
        tab({ state: 'IDLE' }),
        tab({ state: 'FROZEN' }),
        tab({ state: 'HIBERNATED' })
      ],
      0
    )
    expect(health).toMatchObject({ total: 4, active: 1, idle: 1, asleep: 2 })
  })

  it('offers only idle tabs that nothing is blocking', () => {
    const health = summariseTabHealth(
      [
        tab({ tabId: 'ok', state: 'IDLE' }),
        tab({ tabId: 'audio', state: 'IDLE', blockers: ['playing-audio'] }),
        tab({ tabId: 'awake', state: 'ACTIVE' })
      ],
      0
    )
    expect(health.sleepableIds).toEqual(['ok'])
  })

  it('does not call an already-sleeping tab blocked', () => {
    // A hibernated tab is not "unsafe to sleep", it is asleep. Counting it as
    // blocked reports a healthy browser as one full of problems.
    const health = summariseTabHealth(
      [tab({ state: 'HIBERNATED', blockers: ['already-hibernated'] })],
      0
    )
    expect(health.blockedCount).toBe(0)
  })

  it('does not call the active tab or an internal page blocked', () => {
    const health = summariseTabHealth(
      [
        tab({ state: 'ACTIVE', blockers: ['active-tab'] }),
        tab({ state: 'ACTIVE', blockers: ['internal-page'] })
      ],
      0
    )
    expect(health.blockedCount).toBe(0)
  })

  it('counts a genuinely held tab as blocked', () => {
    const health = summariseTabHealth(
      [tab({ state: 'IDLE', blockers: ['unsaved-form-input'] })],
      0
    )
    expect(health.blockedCount).toBe(1)
    expect(health.sleepableIds).toEqual([])
  })

  it('adds up measured savings and estimated opportunity separately', () => {
    // These are two different claims about two different things, and the whole
    // point of this module is that they are never merged into one number.
    const health = summariseTabHealth(
      [
        tab({ state: 'IDLE', memoryBytes: 200 * MB }),
        tab({ state: 'HIBERNATED', memoryBytes: null, measuredSavingsBytes: 300 * MB })
      ],
      0
    )
    expect(health.estimatedOpportunityBytes).toBe(200 * MB)
    expect(health.measuredFreedBytes).toBe(300 * MB)
  })

  it('does not count a hibernated tab as an opportunity', () => {
    // It has already given back what it had.
    const health = summariseTabHealth(
      [tab({ state: 'HIBERNATED', memoryBytes: null, measuredSavingsBytes: 100 * MB })],
      0
    )
    expect(health.estimatedOpportunityBytes).toBe(0)
  })

  it('treats an unmeasurable tab as zero rather than guessing', () => {
    const health = summariseTabHealth([tab({ state: 'IDLE', memoryBytes: null })], 0)
    expect(health.sleepableIds).toHaveLength(1)
    expect(health.estimatedOpportunityBytes).toBe(0)
  })

  it('reports when memory could not be measured at all', () => {
    const health = summariseTabHealth([tab({ memoryBytes: null })], 0)
    expect(health.memoryMeasurable).toBe(false)
  })

  it('reports a shared renderer, because its memory is not one tab’s', () => {
    const health = summariseTabHealth([tab({ sharedProcess: true })], 0)
    expect(health.hasSharedProcesses).toBe(true)
  })

  it('carries the duplicate count through', () => {
    expect(summariseTabHealth([tab()], 5).duplicateCount).toBe(5)
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 MB'],
    [-1, '0 MB'],
    [1024, '<1 MB'],
    [50 * MB, '50 MB'],
    [1023 * MB, '1023 MB'],
    [1536 * MB, '1.5 GB']
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('memoryCaption', () => {
  const health = (over: Partial<ReturnType<typeof summariseTabHealth>>) => ({
    ...summariseTabHealth([], 0),
    ...over
  })

  it('says so when nothing could be measured', () => {
    expect(memoryCaption(health({ memoryMeasurable: false }))).toContain('could not be measured')
  })

  it('calls the opportunity an estimate', () => {
    const text = memoryCaption(
      health({ memoryMeasurable: true, estimatedOpportunityBytes: 500 * MB })
    )
    expect(text).toContain('estimate')
    expect(text).toContain('500 MB')
  })

  it('calls the released bytes measured, and says when they were taken', () => {
    const text = memoryCaption(health({ memoryMeasurable: true, measuredFreedBytes: 2048 * MB }))
    expect(text).toContain('measured')
    expect(text).toContain('2.0 GB')
  })

  it('never presents the two figures as one total', () => {
    const text = memoryCaption(
      health({
        memoryMeasurable: true,
        estimatedOpportunityBytes: 100 * MB,
        measuredFreedBytes: 200 * MB
      })
    )
    expect(text).toContain('100 MB')
    expect(text).toContain('200 MB')
    expect(text).not.toContain('300 MB')
  })

  it('adds the shared-renderer caveat when one applies', () => {
    const text = memoryCaption(
      health({ memoryMeasurable: true, estimatedOpportunityBytes: MB, hasSharedProcesses: true })
    )
    expect(text).toContain('share a renderer')
  })

  it('says plainly when there is nothing to free', () => {
    expect(memoryCaption(health({ memoryMeasurable: true }))).toContain('Nothing is currently')
  })

  it('does not claim nothing is available while duplicates are on offer', () => {
    // These sat next to each other on the panel: this line said nothing could
    // be freed, while the suggestion below offered 144 MB from closing
    // duplicate tabs. Two different claims, but a reader is entitled to treat
    // one panel as one answer.
    const text = memoryCaption(health({ memoryMeasurable: true, duplicateCount: 2 }))
    expect(text).not.toContain('Nothing is currently')
    expect(text).toContain('duplicates')
  })
})
