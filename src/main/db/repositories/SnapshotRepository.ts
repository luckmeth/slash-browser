import type {
  Snapshot,
  SnapshotDetail,
  SnapshotKind,
  SnapshotTab,
  NavigationEntrySnapshot
} from '@shared/types/snapshot'
import type { Database } from '../Database'
import { createLogger } from '../../logger'

const log = createLogger('snapshots')

interface SnapshotRow {
  id: number
  label: string
  kind: string
  created_at: number
}

interface TabRow {
  url: string
  title: string
  favicon_url: string | null
  workspace_id: string
  tab_order: number
  window_index: number
  is_pinned: number
  group_id: string | null
  scroll_y: number
  entries_json: string
  active_entry_index: number
}

export class SnapshotRepository {
  constructor(private readonly db: Database) {}

  create(label: string, kind: SnapshotKind, tabs: readonly SnapshotTab[]): number {
    // One transaction: a snapshot that recorded its header but only half its
    // tabs would look like a valid restore point and silently lose the rest.
    const insert = this.db.connection.transaction(() => {
      const info = this.db.connection
        .prepare('INSERT INTO snapshots (label, kind, created_at) VALUES (?, ?, ?)')
        .run(label, kind, Date.now())
      const snapshotId = Number(info.lastInsertRowid)

      const insertTab = this.db.connection.prepare(
        `INSERT INTO snapshot_tabs
           (snapshot_id, url, title, favicon_url, workspace_id, tab_order,
            window_index, is_pinned, group_id, scroll_y, entries_json,
            active_entry_index)
         VALUES (@snapshotId, @url, @title, @favicon, @workspaceId, @order,
                 @windowIndex, @isPinned, @groupId, @scrollY, @entries,
                 @activeIndex)`
      )
      for (const tab of tabs) {
        insertTab.run({
          snapshotId,
          url: tab.url,
          title: tab.title,
          favicon: tab.faviconUrl,
          workspaceId: tab.workspaceId,
          order: tab.order,
          windowIndex: tab.windowIndex,
          isPinned: tab.isPinned ? 1 : 0,
          groupId: tab.groupId,
          scrollY: tab.scrollY,
          entries: JSON.stringify(tab.entries),
          activeIndex: tab.activeEntryIndex
        })
      }
      return snapshotId
    })

    return insert()
  }

  list(limit = 100): Snapshot[] {
    const rows = this.db.connection
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM snapshot_tabs t WHERE t.snapshot_id = s.id) AS tab_count,
                (SELECT COUNT(DISTINCT t.workspace_id) FROM snapshot_tabs t WHERE t.snapshot_id = s.id) AS ws_count
         FROM snapshots s
         ORDER BY s.created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<SnapshotRow & { tab_count: number; ws_count: number }>

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      kind: row.kind as SnapshotKind,
      createdAt: row.created_at,
      tabCount: row.tab_count,
      workspaceCount: row.ws_count
    }))
  }

  detail(id: number): SnapshotDetail | null {
    const row = this.db.connection.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as
      | SnapshotRow
      | undefined
    if (!row) return null

    const tabs = this.tabsFor(id)
    return {
      id: row.id,
      label: row.label,
      kind: row.kind as SnapshotKind,
      createdAt: row.created_at,
      tabCount: tabs.length,
      workspaceCount: new Set(tabs.map((t) => t.workspaceId)).size,
      tabs
    }
  }

  tabsFor(snapshotId: number): SnapshotTab[] {
    const rows = this.db.connection
      .prepare(
        'SELECT * FROM snapshot_tabs WHERE snapshot_id = ? ORDER BY window_index, tab_order'
      )
      .all(snapshotId) as TabRow[]

    return rows.map((row) => ({
      url: row.url,
      title: row.title,
      faviconUrl: row.favicon_url,
      workspaceId: row.workspace_id,
      order: row.tab_order,
      windowIndex: row.window_index ?? 0,
      isPinned: row.is_pinned === 1,
      groupId: row.group_id,
      scrollY: row.scroll_y,
      entries: parseEntries(row.entries_json),
      activeEntryIndex: row.active_entry_index
    }))
  }

  /** Most recent snapshot of a given kind — the one offered at startup. */
  latestOfKind(kind: SnapshotKind): SnapshotDetail | null {
    const row = this.db.connection
      .prepare('SELECT id FROM snapshots WHERE kind = ? ORDER BY created_at DESC LIMIT 1')
      .get(kind) as { id: number } | undefined
    return row ? this.detail(row.id) : null
  }

  /**
   * Renames a restore point, and promotes it to a kept one.
   *
   * The kind changes to `manual` because that is what the word means here:
   * `pruneAutomatic` deletes automatic snapshots past the retention window, so
   * naming one and leaving it automatic would let the browser quietly throw
   * away the thing somebody had just said they wanted to keep.
   */
  rename(id: number, label: string): void {
    this.db.connection
      .prepare(`UPDATE snapshots SET label = ?, kind = 'manual' WHERE id = ?`)
      .run(label, id)
  }

  delete(id: number): void {
    // snapshot_tabs cascades.
    this.db.connection.prepare('DELETE FROM snapshots WHERE id = ?').run(id)
  }

  /**
   * Prunes automatic snapshots past the retention window.
   *
   * Manual restore points are never pruned — the user named them, which is a
   * clear statement that they should stay until deleted deliberately.
   */
  pruneAutomatic(olderThan: number): number {
    const info = this.db.connection
      .prepare(`DELETE FROM snapshots WHERE kind = 'automatic' AND created_at < ?`)
      .run(olderThan)
    if (info.changes > 0) log.info(`pruned ${info.changes} automatic snapshot(s)`)
    return info.changes
  }

  /** Keeps only the newest N session-end snapshots. */
  trimSessionEnd(keep: number): void {
    this.db.connection
      .prepare(
        `DELETE FROM snapshots
         WHERE kind = 'session-end'
           AND id NOT IN (
             SELECT id FROM snapshots WHERE kind = 'session-end'
             ORDER BY created_at DESC LIMIT ?
           )`
      )
      .run(keep)
  }
}

function parseEntries(json: string): NavigationEntrySnapshot[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    // Tolerant on read: a snapshot with one malformed entry should still restore
    // the rest rather than throwing away the whole tab.
    return parsed.filter(
      (entry): entry is NavigationEntrySnapshot =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { url?: unknown }).url === 'string'
    )
  } catch {
    return []
  }
}
