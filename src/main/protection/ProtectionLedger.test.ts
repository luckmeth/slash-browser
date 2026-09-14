import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ProtectionLedger, RETENTION_DAYS } from './ProtectionLedger'
import type { ProtectionField } from '../db/repositories/ProtectionRepository'
import type { ProtectionDay } from '@shared/protectionReport'

/**
 * A stand-in for the repository.
 *
 * The ledger is the piece worth testing — the buffering, the day rollover, and
 * that a failed write cannot take the browser down with it. The SQL belongs to
 * SQLite, which is not ours to verify.
 */
function fakeRepository() {
  const writes: Array<{ day: string; deltas: Partial<Record<ProtectionField, number>> }> = []
  let pruned: string | null = null
  let throwOnAdd = false

  return {
    writes,
    get pruned() {
      return pruned
    },
    fail(): void {
      throwOnAdd = true
    },
    add(day: string, deltas: Partial<Record<ProtectionField, number>>): void {
      if (throwOnAdd) throw new Error('disk is full')
      writes.push({ day, deltas })
    },
    since(): ProtectionDay[] {
      return []
    },
    deniedPermissionsSince(): number {
      return 4
    },
    prune(beforeDay: string): void {
      pruned = beforeDay
    },
    clear(): void {
      writes.length = 0
    }
  }
}

describe('ProtectionLedger', () => {
  let repo: ReturnType<typeof fakeRepository>
  let clock: number

  beforeEach(() => {
    repo = fakeRepository()
    clock = new Date(2026, 8, 14, 12, 0).getTime()
  })

  const ledger = (): ProtectionLedger =>
    new ProtectionLedger(repo as never, () => clock)

  it('writes nothing until it is flushed', () => {
    // The whole point of the buffer: a blocked request must not cost a write,
    // and ActivityLog.record runs on the request path for every page.
    const led = ledger()
    led.add('ads')
    led.add('ads')
    led.add('trackers')
    expect(repo.writes).toEqual([])
  })

  it('writes one statement for a run of increments', () => {
    const led = ledger()
    for (let i = 0; i < 40; i += 1) led.add('trackers')
    led.flush()
    expect(repo.writes).toEqual([{ day: '2026-09-14', deltas: { trackers: 40 } }])
  })

  it('flushes nothing when nothing happened', () => {
    ledger().flush()
    expect(repo.writes).toEqual([])
  })

  it('ignores a non-positive count', () => {
    const led = ledger()
    led.add('ads', 0)
    led.add('ads', -5)
    led.flush()
    expect(repo.writes).toEqual([])
  })

  it('files the small hours under the right day', () => {
    // A browser left open overnight would otherwise put yesterday's counts and
    // today's into one row under whichever date the flush happened to land on.
    const led = ledger()
    led.add('ads', 3)

    clock = new Date(2026, 8, 15, 0, 30).getTime()
    led.add('ads', 1)
    led.flush()

    expect(repo.writes).toEqual([
      { day: '2026-09-14', deltas: { ads: 3 } },
      { day: '2026-09-15', deltas: { ads: 1 } }
    ])
  })

  it('does not write the same counts twice', () => {
    const led = ledger()
    led.add('popups', 2)
    led.flush()
    led.flush()
    expect(repo.writes).toHaveLength(1)
  })

  it('survives a write that fails', () => {
    // A counter is never worth failing a browser over. The count is lost, which
    // is the right trade for a number on a dashboard.
    const led = ledger()
    repo.fail()
    led.add('ads')
    expect(() => led.flush()).not.toThrow()
  })

  it('prunes past the retention window when it starts', () => {
    const led = ledger()
    led.start()
    led.stop()
    // 31 days back from 14 September, inclusive of today.
    expect(repo.pruned).toBe('2026-08-15')
    expect(RETENTION_DAYS).toBe(31)
  })

  it('flushes on stop, so a clean quit loses nothing', () => {
    const led = ledger()
    led.start()
    led.add('redirects', 7)
    led.stop()
    expect(repo.writes).toEqual([{ day: '2026-09-14', deltas: { redirects: 7 } }])
  })

  it('flushes before reading, so the week includes what just happened', () => {
    const led = ledger()
    led.add('ads', 5)
    const week = led.week()
    expect(repo.writes).toHaveLength(1)
    expect(week.permissionsDenied).toBe(4)
  })

  it('does not hold the process open', () => {
    // A browser with nothing else to do should quit; the flush at stop catches
    // whatever the timer would have.
    const unref = vi.fn()
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue({ unref } as never)
    const led = ledger()
    led.start()
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
    led.stop()
  })
})
