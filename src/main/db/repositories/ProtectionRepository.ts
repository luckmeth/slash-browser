import type { Database } from '../Database'
import { EMPTY_DAY, type ProtectionDay } from '@shared/protectionReport'

/** The columns a caller may increment, and the SQL column each maps to. */
export const PROTECTION_FIELDS = {
  ads: 'ads',
  trackers: 'trackers',
  popups: 'popups',
  redirects: 'redirects',
  tabsHibernated: 'tabs_hibernated',
  bytesFreed: 'bytes_freed',
  duplicatesClosed: 'duplicates_closed',
  downloadsFlagged: 'downloads_flagged',
  sessionsRestored: 'sessions_restored',
  tabsRestored: 'tabs_restored'
} as const

export type ProtectionField = keyof typeof PROTECTION_FIELDS

interface Row {
  day: string
  ads: number
  trackers: number
  popups: number
  redirects: number
  tabs_hibernated: number
  bytes_freed: number
  duplicates_closed: number
  downloads_flagged: number
  sessions_restored: number
  tabs_restored: number
}

/**
 * Counts of what the browser did, by day.
 *
 * Counts only. There is no host, no URL and no tab id in this table — a record
 * of which sites blocked what would be a second history of everywhere somebody
 * has been, which is the thing the blocker exists to prevent.
 */
export class ProtectionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Adds a day's worth of increments in one statement.
   *
   * Takes a whole batch rather than one field at a time because the caller
   * buffers in memory: a blocked request must not cost a database write, and
   * `ActivityLog.record` runs on the request path for every page.
   */
  add(day: string, deltas: Partial<Record<ProtectionField, number>>): void {
    const entries = Object.entries(deltas).filter(
      (entry): entry is [ProtectionField, number] =>
        typeof entry[1] === 'number' && entry[1] !== 0
    )
    if (entries.length === 0) return

    const columns = entries.map(([field]) => PROTECTION_FIELDS[field])
    const values = entries.map(([, value]) => value)

    // One upsert: insert the day with these values, or add them to the row that
    // is already there. `excluded` is the row this statement tried to insert.
    this.db.connection
      .prepare(
        `INSERT INTO protection_days (day, ${columns.join(', ')})
         VALUES (?, ${columns.map(() => '?').join(', ')})
         ON CONFLICT(day) DO UPDATE SET
           ${columns.map((column) => `${column} = ${column} + excluded.${column}`).join(', ')}`
      )
      .run(day, ...values)
  }

  /** Every day from `fromDay` onwards, oldest first. */
  since(fromDay: string): ProtectionDay[] {
    const rows = this.db.connection
      .prepare<[string], Row>(
        `SELECT day, ads, trackers, popups, redirects, tabs_hibernated, bytes_freed,
                duplicates_closed, downloads_flagged, sessions_restored, tabs_restored
           FROM protection_days WHERE day >= ? ORDER BY day ASC`
      )
      .all(fromDay)

    return rows.map((row) => ({
      day: row.day,
      ads: row.ads,
      trackers: row.trackers,
      popups: row.popups,
      redirects: row.redirects,
      tabsHibernated: row.tabs_hibernated,
      bytesFreed: row.bytes_freed,
      duplicatesClosed: row.duplicates_closed,
      downloadsFlagged: row.downloads_flagged,
      sessionsRestored: row.sessions_restored,
      tabsRestored: row.tabs_restored
    }))
  }

  /** Permission requests refused since a moment, from the permission log. */
  deniedPermissionsSince(at: number): number {
    const row = this.db.connection
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM permission_events WHERE action = 'denied' AND at >= ?`
      )
      .get(at)
    return row?.n ?? 0
  }

  /**
   * Drops days past the window.
   *
   * The report covers a week, so keeping years of rows would be collecting data
   * for no stated purpose — which is the same objection this project raises to
   * anything else that accumulates quietly. A month gives the week somewhere to
   * sit while a browser that was closed for a few days catches up.
   */
  prune(beforeDay: string): void {
    this.db.connection.prepare('DELETE FROM protection_days WHERE day < ?').run(beforeDay)
  }

  clear(): void {
    this.db.connection.prepare('DELETE FROM protection_days').run()
  }
}

export { EMPTY_DAY }
