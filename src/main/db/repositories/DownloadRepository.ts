import type { DownloadItem, DownloadState } from '@shared/types/browsing'
import type { Database } from '../Database'

interface DownloadRow {
  id: string
  url: string
  filename: string
  save_path: string
  mime_type: string
  total_bytes: number
  received_bytes: number
  state: string
  is_dangerous: number
  started_at: number
  completed_at: number | null
}

function toItem(row: DownloadRow): DownloadItem {
  return {
    id: row.id,
    url: row.url,
    filename: row.filename,
    savePath: row.save_path,
    mimeType: row.mime_type,
    totalBytes: row.total_bytes,
    receivedBytes: row.received_bytes,
    state: row.state as DownloadState,
    isDangerous: row.is_dangerous === 1,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

export class DownloadRepository {
  constructor(private readonly db: Database) {}

  upsert(item: DownloadItem): void {
    this.db.connection
      .prepare(
        `INSERT INTO downloads
           (id, url, filename, save_path, mime_type, total_bytes, received_bytes,
            state, is_dangerous, started_at, completed_at)
         VALUES
           (@id, @url, @filename, @savePath, @mimeType, @totalBytes, @receivedBytes,
            @state, @isDangerous, @startedAt, @completedAt)
         ON CONFLICT(id) DO UPDATE SET
           received_bytes = excluded.received_bytes,
           total_bytes    = excluded.total_bytes,
           state          = excluded.state,
           save_path      = excluded.save_path,
           completed_at   = excluded.completed_at`
      )
      .run({
        id: item.id,
        url: item.url,
        filename: item.filename,
        savePath: item.savePath,
        mimeType: item.mimeType,
        totalBytes: item.totalBytes,
        receivedBytes: item.receivedBytes,
        state: item.state,
        isDangerous: item.isDangerous ? 1 : 0,
        startedAt: item.startedAt,
        completedAt: item.completedAt
      })
  }

  list(): DownloadItem[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM downloads ORDER BY started_at DESC')
      .all() as DownloadRow[]
    return rows.map(toItem)
  }

  remove(id: string): void {
    this.db.connection.prepare('DELETE FROM downloads WHERE id = ?').run(id)
  }

  clearCompleted(): void {
    this.db.connection
      .prepare(`DELETE FROM downloads WHERE state IN ('completed', 'cancelled', 'interrupted')`)
      .run()
  }

  /**
   * Electron cannot resume a DownloadItem whose process has exited — the
   * in-flight request is gone. Anything still marked in-progress from a previous
   * run is therefore stale, and is reconciled to `interrupted` at startup rather
   * than shown as a transfer that will never advance.
   */
  reconcileInterrupted(): number {
    const info = this.db.connection
      .prepare(
        `UPDATE downloads SET state = 'interrupted'
         WHERE state IN ('progressing', 'paused')`
      )
      .run()
    return info.changes
  }
}
