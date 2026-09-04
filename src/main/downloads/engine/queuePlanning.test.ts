import { describe, expect, it } from 'vitest'
import type { EngineDownload } from '@shared/types/downloadEngine'
import {
  DEFAULT_QUEUE_ID,
  type QueueDefinition,
  selectStartable,
  whyHeld
} from './queuePlanning'

const NOW = 1_700_000_000_000

function record(over: Partial<EngineDownload> = {}): EngineDownload {
  return {
    id: 'a',
    state: 'queued',
    priority: 'normal',
    queue: DEFAULT_QUEUE_ID,
    startAfter: null,
    startedAt: NOW,
    ...over
  } as EngineDownload
}

const queue = (over: Partial<QueueDefinition> = {}): QueueDefinition => ({
  id: DEFAULT_QUEUE_ID,
  name: 'Main',
  maxConcurrent: 3,
  paused: false,
  ...over
})

describe('selectStartable', () => {
  it('starts what is queued, up to the queue limit', () => {
    const records = [record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' }), record({ id: 'd' })]
    const { start } = selectStartable(records, new Set(), [queue({ maxConcurrent: 2 })], 10, NOW)
    expect(start).toEqual(['a', 'b'])
  })

  it('counts what is already running against its queue', () => {
    const records = [record({ id: 'a' }), record({ id: 'b' })]
    const { start } = selectStartable(records, new Set(['a']), [queue({ maxConcurrent: 1 })], 10, NOW)
    expect(start).toEqual([])
  })

  it('runs two queues independently', () => {
    // The point of the feature: one queue being busy must not hold up another.
    const queues = [queue({ id: 'main', maxConcurrent: 1 }), queue({ id: 'films', name: 'Films', maxConcurrent: 1 })]
    const records = [
      record({ id: 'a', queue: 'main' }),
      record({ id: 'b', queue: 'main' }),
      record({ id: 'c', queue: 'films' })
    ]
    const { start } = selectStartable(records, new Set(), queues, 10, NOW)
    expect(start).toEqual(['a', 'c'])
  })

  it('a paused queue starts nothing and does not block the others', () => {
    const queues = [
      queue({ id: 'main', maxConcurrent: 2, paused: true }),
      queue({ id: 'films', name: 'Films', maxConcurrent: 2 })
    ]
    const records = [record({ id: 'a', queue: 'main' }), record({ id: 'c', queue: 'films' })]
    expect(selectStartable(records, new Set(), queues, 10, NOW).start).toEqual(['c'])
  })

  it('pausing a queue does not evict what is already running', () => {
    // Pause stops new starts. Killing a transfer in flight would lose its
    // progress, which is not what "pause the queue" means to anyone.
    const queues = [queue({ id: 'main', maxConcurrent: 2, paused: true })]
    const records = [record({ id: 'a', queue: 'main' }), record({ id: 'b', queue: 'main' })]
    const { start } = selectStartable(records, new Set(['a']), queues, 10, NOW)
    expect(start).toEqual([])
  })

  it('honours the global cap above every queue limit', () => {
    // Five queues of three would open fifteen transfers, and all fifteen would
    // be slower than running them in turn.
    const queues = [
      queue({ id: 'q1', maxConcurrent: 3 }),
      queue({ id: 'q2', maxConcurrent: 3 }),
      queue({ id: 'q3', maxConcurrent: 3 })
    ]
    const records = ['q1', 'q2', 'q3'].flatMap((q, i) =>
      [0, 1, 2].map((n) => record({ id: `${q}-${n}`, queue: q, startedAt: NOW + i * 10 + n }))
    )
    const { start } = selectStartable(records, new Set(), queues, 4, NOW)
    expect(start).toHaveLength(4)
  })

  it('starts high priority first', () => {
    const records = [
      record({ id: 'low', priority: 'low', startedAt: NOW }),
      record({ id: 'high', priority: 'high', startedAt: NOW + 100 })
    ]
    const { start } = selectStartable(records, new Set(), [queue({ maxConcurrent: 1 })], 10, NOW)
    expect(start).toEqual(['high'])
  })

  it('breaks a priority tie by age, oldest first', () => {
    const records = [
      record({ id: 'newer', startedAt: NOW + 500 }),
      record({ id: 'older', startedAt: NOW })
    ]
    const { start } = selectStartable(records, new Set(), [queue({ maxConcurrent: 1 })], 10, NOW)
    expect(start).toEqual(['older'])
  })

  it('holds a scheduled download and reports when to look again', () => {
    const due = NOW + 60_000
    const records = [record({ id: 'later', startAfter: due })]
    const result = selectStartable(records, new Set(), [queue()], 10, NOW)
    expect(result.start).toEqual([])
    expect(result.heldUntil).toBe(due)
  })

  it('reports the soonest hold when several are scheduled', () => {
    // One timer, armed for the earliest — a queue holding a transfer for six
    // hours must not wake every second to check.
    const records = [
      record({ id: 'a', startAfter: NOW + 90_000 }),
      record({ id: 'b', startAfter: NOW + 30_000 })
    ]
    expect(selectStartable(records, new Set(), [queue()], 10, NOW).heldUntil).toBe(NOW + 30_000)
  })

  it('starts a scheduled download once its time has passed', () => {
    const records = [record({ id: 'due', startAfter: NOW - 1 })]
    expect(selectStartable(records, new Set(), [queue()], 10, NOW).start).toEqual(['due'])
  })

  it('falls back to the first queue when a download names one that is gone', () => {
    // Deleting a queue must not strand its downloads unrunnable for ever.
    const records = [record({ id: 'orphan', queue: 'deleted-queue' })]
    expect(selectStartable(records, new Set(), [queue({ id: 'main' })], 10, NOW).start).toEqual([
      'orphan'
    ])
  })

  it('ignores anything not queued', () => {
    const records = [record({ id: 'done', state: 'completed' }), record({ id: 'p', state: 'paused' })]
    expect(selectStartable(records, new Set(), [queue()], 10, NOW).start).toEqual([])
  })
})

describe('whyHeld', () => {
  it('says nothing about a download that is not waiting', () => {
    expect(whyHeld(record({ state: 'downloading' }), [queue()], NOW)).toBeNull()
  })

  it('names the schedule before anything else', () => {
    expect(whyHeld(record({ startAfter: NOW + 5000 }), [queue()], NOW)).toContain('Scheduled')
  })

  it('names the paused queue, because that is what the user can act on', () => {
    const held = whyHeld(record({ queue: 'films' }), [queue({ id: 'films', name: 'Films', paused: true })], NOW)
    expect(held).toBe('The Films queue is paused.')
  })

  it('falls back to waiting for a slot', () => {
    expect(whyHeld(record(), [queue()], NOW)).toBe('Waiting for a free slot.')
  })
})
