import type { HistoryEntry } from '@shared/types/browsing'
import type { Database } from '../Database'

interface HistoryRow {
  id: number
  url: string
  title: string
  favicon_url: string | null
  visit_count: number
  last_visited_at: number
}

function toEntry(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    faviconUrl: row.favicon_url,
    visitCount: row.visit_count,
    lastVisitedAt: row.last_visited_at
  }
}

export class HistoryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Records a visit, incrementing the counter for a URL already seen.
   *
   * The title is only overwritten when a non-empty one is supplied: `did-navigate`
   * fires before the document has a title, so a naive write would blank out a
   * good title from a previous visit and then leave it blank until the
   * `page-title-updated` event arrives.
   */
  recordVisit(url: string, title: string, faviconUrl: string | null): void {
    this.db.connection
      .prepare(
        `INSERT INTO history_visits (url, title, favicon_url, visit_count, last_visited_at)
         VALUES (@url, @title, @favicon, 1, @now)
         ON CONFLICT(url) DO UPDATE SET
           visit_count     = visit_count + 1,
           last_visited_at = @now,
           title           = CASE WHEN @title != '' THEN @title ELSE title END,
           favicon_url     = COALESCE(@favicon, favicon_url)`
      )
      .run({ url, title, favicon: faviconUrl, now: Date.now() })
  }

  /** Updates metadata for an existing URL without counting another visit. */
  updateMetadata(url: string, title: string, faviconUrl: string | null): void {
    this.db.connection
      .prepare(
        `UPDATE history_visits SET
           title       = CASE WHEN @title != '' THEN @title ELSE title END,
           favicon_url = COALESCE(@favicon, favicon_url)
         WHERE url = @url`
      )
      .run({ url, title, favicon: faviconUrl })
  }

  search(query: string, limit: number, offset: number): HistoryEntry[] {
    // Phase 1 is deliberately LIKE-based. Phase 5 replaces this with FTS5 + BM25
    // behind a SearchProvider interface; keeping the shape identical means that
    // swap does not ripple into callers.
    const rows = query.trim()
      ? (this.db.connection
          .prepare(
            `SELECT * FROM history_visits
             WHERE url LIKE @like OR title LIKE @like
             ORDER BY last_visited_at DESC
             LIMIT @limit OFFSET @offset`
          )
          .all({ like: `%${query.trim()}%`, limit, offset }) as HistoryRow[])
      : (this.db.connection
          .prepare(
            `SELECT * FROM history_visits ORDER BY last_visited_at DESC LIMIT @limit OFFSET @offset`
          )
          .all({ limit, offset }) as HistoryRow[])

    return rows.map(toEntry)
  }

  /** Most-visited entries matching a prefix. Feeds omnibox suggestions. */
  suggest(prefix: string, limit: number): HistoryEntry[] {
    const trimmed = prefix.trim()
    if (!trimmed) return []
    const rows = this.db.connection
      .prepare(
        `SELECT * FROM history_visits
         WHERE url LIKE @like OR title LIKE @like
         ORDER BY visit_count DESC, last_visited_at DESC
         LIMIT @limit`
      )
      .all({ like: `%${trimmed}%`, limit }) as HistoryRow[]
    return rows.map(toEntry)
  }

  deleteByIds(ids: readonly number[]): void {
    if (ids.length === 0) return
    const statement = this.db.connection.prepare('DELETE FROM history_visits WHERE id = ?')
    const deleteAll = this.db.connection.transaction((all: readonly number[]) => {
      for (const id of all) statement.run(id)
    })
    deleteAll(ids)
  }

  /** @param since Epoch ms; omit to clear everything. */
  clear(since?: number): void {
    if (since === undefined) {
      this.db.connection.prepare('DELETE FROM history_visits').run()
      return
    }
    this.db.connection.prepare('DELETE FROM history_visits WHERE last_visited_at >= ?').run(since)
  }
}
