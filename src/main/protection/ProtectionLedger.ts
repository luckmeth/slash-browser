import { localDay, windowStart, type ProtectionDay } from '@shared/protectionReport'
import type { ProtectionField, ProtectionRepository } from '../db/repositories/ProtectionRepository'
import { createLogger } from '../logger'

const log = createLogger('protection')

/**
 * How long counts sit in memory before they are written.
 *
 * The whole reason this buffer exists is principle 1: `ActivityLog.record` runs
 * on the request path for every blocked request on every page, and a database
 * write there would be a cost paid constantly for a number nobody is looking at.
 * Thirty seconds is short enough that a crash loses a handful of counts rather
 * than an afternoon, and long enough that a page full of trackers costs one
 * write rather than forty.
 */
export const FLUSH_INTERVAL_MS = 30_000

/**
 * How much history to keep.
 *
 * The report covers a week. Keeping years of daily counters would be collecting
 * data for no stated purpose, which is the objection this project raises to
 * everything else that accumulates quietly. A month leaves room for a browser
 * that was closed for a few days.
 */
export const RETENTION_DAYS = 31

/**
 * Counts what the browser did, cheaply.
 *
 * Increments land in a plain object and are written in one statement on a timer
 * and at quit. Reads add the unflushed buffer back on, so the panel is current
 * without forcing a write every time somebody opens it.
 */
export class ProtectionLedger {
  private pending: Partial<Record<ProtectionField, number>> = {}
  /** The day the pending counts belong to, so midnight does not merge two. */
  private pendingDay: string
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly repository: ProtectionRepository,
    private readonly now: () => number = () => Date.now()
  ) {
    this.pendingDay = localDay(this.now())
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    // Never hold the process open for a counter. A browser that has nothing
    // else to do should quit, and the flush at quit catches whatever is left.
    this.timer.unref?.()

    this.repository.prune(windowStart(this.now(), RETENTION_DAYS))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flush()
  }

  /**
   * Records something that happened.
   *
   * Cheap by construction: an object property increment and, when the day has
   * rolled over, one write. Nothing else may be added to this path.
   */
  add(field: ProtectionField, count = 1): void {
    if (count <= 0) return

    const today = localDay(this.now())
    if (today !== this.pendingDay) {
      // Write yesterday's under yesterday's date before starting today's, or a
      // browser left open overnight files the small hours under the wrong day.
      this.flush()
      this.pendingDay = today
    }

    this.pending[field] = (this.pending[field] ?? 0) + count
  }

  flush(): void {
    const deltas = this.pending
    if (Object.keys(deltas).length === 0) return
    this.pending = {}
    try {
      this.repository.add(this.pendingDay, deltas)
    } catch (error) {
      // A counter is never worth failing a browser over. The count is lost,
      // which is the correct trade — it is a number on a dashboard.
      log.warn(`could not write protection counts — ${String(error)}`)
    }
  }

  /** The week's days, including anything not yet written. */
  week(): { days: ProtectionDay[]; permissionsDenied: number } {
    this.flush()
    const now = this.now()
    const days = this.repository.since(windowStart(now))
    const since = now - 7 * 24 * 60 * 60 * 1000
    return { days, permissionsDenied: this.repository.deniedPermissionsSince(since) }
  }

  clear(): void {
    this.pending = {}
    this.repository.clear()
  }
}
