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
 * A stored entry, carrying the row id that identifies it.
 *
 * The id and not `closedAt`: closing a window shuts every tab in the same
 * millisecond, so a timestamp is not a name for one of them. Anything that
 * reopens a *particular* closed tab has to be able to say which.
 */
export type StoredClosedTab = ClosedTabRecord & { readonly id: number }

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
  list(): StoredClosedTab[] {
    const rows = this.db.connection
      .prepare<[number], Row & { id: number }>(
        `SELECT id, url, title, favicon_url, tab_index, is_pinned, workspace_id, navigation, closed_at
           FROM closed_tabs ORDER BY closed_at DESC, id DESC LIMIT ?`
      )
      .all(CLOSED_TAB_LIMIT)

    return rows.reverse().map(toRecord)
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
  takeLatest(): StoredClosedTab | null {
    const row = this.db.connection
      .prepare<[], Row & { id: number }>(
        `SELECT id, url, title, favicon_url, tab_index, is_pinned, workspace_id, navigation, closed_at
           FROM closed_tabs ORDER BY closed_at DESC, id DESC LIMIT 1`
      )
      .get()
    if (!row) return null

    this.db.connection.prepare('DELETE FROM closed_tabs WHERE id = ?').run(row.id)
    return toRecord(row)
  }

  /**
   * Removes one particular entry — what reopening from a *list* consumes.
   *
   * Returns null when the id is not there, which is an ordinary outcome rather
   * than an error: the list a caller is holding can be a moment out of date, and
   * an entry may already have been reopened, pruned, or cleared.
   */
  take(id: number): StoredClosedTab | null {
    const row = this.db.connection
      .prepare<[number], Row & { id: number }>(
        `SELECT id, url, title, favicon_url, tab_index, is_pinned, workspace_id, navigation, closed_at
           FROM closed_tabs WHERE id = ?`
      )
      .get(id)
    if (!row) return null

    this.db.connection.prepare('DELETE FROM closed_tabs WHERE id = ?').run(row.id)
    return toRecord(row)
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

/** One place that turns a row into a record, so the three readers cannot drift. */
function toRecord(row: Row & { id: number }): StoredClosedTab {
  return {
    id: row.id,
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
