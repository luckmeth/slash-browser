import type { Database } from '../Database'

/**
 * Recently-closed tabs, persisted so reopening one survives a restart.
 *
 * The in-memory version discarded everything on quit — which meant the list was
 * empty at exactly the moment it is most useful, just after reopening the
 * browser. Closing a tab you wanted was recoverable for as long as you did not
 * close the browser, which is not what "reopen closed tab" implies.
 *
 * Stores what a tab *is*, never what it was showing: address, title, favicon,
 * position, and back/forward history. No page content, no form state.
 */
export interface ClosedTabRecord {
  readonly url: string
  readonly title: string
  readonly faviconUrl: string | null
  readonly index: number
  readonly isPinned: boolean
  readonly workspaceId: string
  /** Serialised navigation history, or empty when there was none to capture. */
  readonly navigation: string
  readonly closedAt: number
}

/**
 * How many to keep.
 *
 * Matches the in-memory stack this replaced. Deep enough to undo a run of
 * accidental closes; shallow enough that the table cannot become a second,
 * unmanaged history of everywhere you have been.
 */
export const CLOSED_TAB_LIMIT = 25

interface Row {
  url: string
  title: string
  favicon_url: string | null
  tab_index: number
  is_pinned: number
  workspace_id: string
  navigation: string
  closed_at: number
}

export class ClosedTabRepository {
  constructor(private readonly db: Database) {}

  /** Oldest first, matching the stack order the tab manager pops from. */
  list(): ClosedTabRecord[] {
    const rows = this.db.connection
      .prepare<[number], Row>(
        `SELECT url, title, favicon_url, tab_index, is_pinned, workspace_id, navigation, closed_at
           FROM closed_tabs ORDER BY closed_at DESC, id DESC LIMIT ?`
      )
      .all(CLOSED_TAB_LIMIT)

    return rows.reverse().map((row) => ({
      url: row.url,
      title: row.title,
      faviconUrl: row.favicon_url,
      index: row.tab_index,
      isPinned: row.is_pinned === 1,
      workspaceId: row.workspace_id,
      navigation: row.navigation,
      closedAt: row.closed_at
    }))
  }

  add(record: ClosedTabRecord): void {
    this.db.connection
      .prepare(
        `INSERT INTO closed_tabs
           (url, title, favicon_url, tab_index, is_pinned, workspace_id, navigation, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.url,
        record.title,
        record.faviconUrl,
        record.index,
        record.isPinned ? 1 : 0,
        record.workspaceId,
        record.navigation,
        record.closedAt
      )
    this.prune()
  }

  /** Removes the most recent entry — what "reopen" consumes. */
  takeLatest(): ClosedTabRecord | null {
    const row = this.db.connection
      .prepare<[], Row & { id: number }>(
        `SELECT id, url, title, favicon_url, tab_index, is_pinned, workspace_id, navigation, closed_at
           FROM closed_tabs ORDER BY closed_at DESC, id DESC LIMIT 1`
      )
      .get()
    if (!row) return null

    this.db.connection.prepare('DELETE FROM closed_tabs WHERE id = ?').run(row.id)
    return {
      url: row.url,
      title: row.title,
      faviconUrl: row.favicon_url,
      index: row.tab_index,
      isPinned: row.is_pinned === 1,
      workspaceId: row.workspace_id,
      navigation: row.navigation,
      closedAt: row.closed_at
    }
  }

  clear(): void {
    this.db.connection.prepare('DELETE FROM closed_tabs').run()
  }

  private prune(): void {
    this.db.connection
      .prepare(
        `DELETE FROM closed_tabs WHERE id NOT IN (
           SELECT id FROM closed_tabs ORDER BY closed_at DESC, id DESC LIMIT ?
         )`
      )
      .run(CLOSED_TAB_LIMIT)
  }
}
