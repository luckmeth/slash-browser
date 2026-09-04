import type {
  DownloadCategory,
  DownloadPriority,
  EngineDownloadState,
  EngineDownloadStore,
  PersistedDownload,
  Segment
} from '@shared/types/downloadEngine'
import type { Database } from '../Database'
import { createLogger } from '../../logger'

const log = createLogger('db')

interface DownloadRow {
  id: string
  url: string
  source_host: string
  filename: string
  save_path: string
  category: string
  state: string
  priority: string
  queue: string
  total_bytes: number | null
  received_bytes: number
  connection_note: string
  start_after: number | null
  attempts: number
  error: string | null
  accepts_ranges: number
  suggested_name: string | null
  mime_type: string | null
  etag: string | null
  last_modified: string | null
  partition: string | null
  referer: string | null
  origin: string | null
  user_agent: string | null
  join_audio_url: string | null
  is_stream: number
  stream_bandwidth: number | null
  stream_quality: string | null
  started_at: number
  updated_at: number
  completed_at: number | null
}

interface SegmentRow {
  download_id: string
  idx: number
  start_byte: number
  end_byte: number
  received_bytes: number
}

/**
 * Where the accelerated engine's downloads are written down.
 *
 * The `downloads` table next door holds Chromium's, and the two are not the
 * same kind of thing. A Chromium download cannot be resumed once the process
 * exits — the request went with it — so that table is a history list, and
 * anything left mid-transfer is reconciled to `interrupted` on the next launch.
 * These *can* be resumed, which is the whole reason for storing them, and doing
 * that needs the segment table and the validator the server gave us.
 *
 * **Nothing stored here is a credential.** The request context is a partition
 * *name*, a referrer and a user agent. Cookies are asked of Chromium's own jar
 * by partition when the download is picked up again, because a cookie copied
 * into a database row is a live credential outliving the tab it came from.
 * Downloads made in a private window are never written at all — the caller
 * decides that, since only it knows which session a download belongs to.
 */
export class EngineDownloadRepository implements EngineDownloadStore {
  constructor(private readonly db: Database) {}

  /**
   * Writes a download and its segments as one unit.
   *
   * In a transaction because a record whose segments belong to an earlier state
   * of it is worse than no record: it would resume from byte offsets that do
   * not match the file on disk, and produce a download that completes with a
   * hole in the middle.
   */
  save(download: PersistedDownload): void {
    const { record, capabilities, request, streamHint } = download

    const write = this.db.connection.transaction(() => {
      this.db.connection
        .prepare(
          `INSERT INTO engine_downloads
             (id, url, source_host, filename, save_path, category, state, priority, queue,
              total_bytes, received_bytes, connection_note, start_after, attempts, error,
              accepts_ranges, suggested_name, mime_type, etag, last_modified,
              partition, referer, origin, user_agent,
              join_audio_url, is_stream, stream_bandwidth, stream_quality,
              started_at, updated_at, completed_at)
           VALUES
             (@id, @url, @sourceHost, @filename, @savePath, @category, @state, @priority, @queue,
              @totalBytes, @receivedBytes, @connectionNote, @startAfter, @attempts, @error,
              @acceptsRanges, @suggestedName, @mimeType, @etag, @lastModified,
              @partition, @referer, @origin, @userAgent,
              @joinAudioUrl, @isStream, @streamBandwidth, @streamQuality,
              @startedAt, @updatedAt, @completedAt)
           ON CONFLICT(id) DO UPDATE SET
             url             = excluded.url,
             filename        = excluded.filename,
             save_path       = excluded.save_path,
             category        = excluded.category,
             state           = excluded.state,
             priority        = excluded.priority,
             queue           = excluded.queue,
             total_bytes     = excluded.total_bytes,
             received_bytes  = excluded.received_bytes,
             connection_note = excluded.connection_note,
             start_after     = excluded.start_after,
             attempts        = excluded.attempts,
             error           = excluded.error,
             accepts_ranges  = excluded.accepts_ranges,
             suggested_name  = excluded.suggested_name,
             mime_type       = excluded.mime_type,
             etag            = excluded.etag,
             last_modified   = excluded.last_modified,
             updated_at      = excluded.updated_at,
             completed_at    = excluded.completed_at`
        )
        .run({
          id: record.id,
          url: record.url,
          sourceHost: record.sourceHost,
          filename: record.filename,
          savePath: record.savePath,
          category: record.category,
          state: record.state,
          priority: record.priority,
          queue: record.queue,
          totalBytes: record.totalBytes,
          receivedBytes: record.receivedBytes,
          connectionNote: record.connectionNote,
          startAfter: record.startAfter,
          attempts: record.attempts,
          error: record.error,
          acceptsRanges: capabilities?.acceptsRanges ? 1 : 0,
          suggestedName: capabilities?.suggestedName ?? null,
          mimeType: capabilities?.mimeType ?? null,
          etag: capabilities?.etag ?? null,
          lastModified: capabilities?.lastModified ?? null,
          partition: request.partition,
          referer: request.referer,
          origin: request.origin,
          userAgent: request.userAgent,
          joinAudioUrl: download.joinAudioUrl,
          isStream: download.isStream ? 1 : 0,
          streamBandwidth: streamHint?.bandwidth ?? null,
          streamQuality: streamHint?.quality ?? null,
          startedAt: record.startedAt,
          updatedAt: Date.now(),
          completedAt: record.completedAt
        })

      // Replaced wholesale rather than merged. A segment table is a single
      // description of one file; merging two of them is how a stale row from an
      // earlier connection plan survives into a new one.
      this.db.connection.prepare('DELETE FROM engine_download_segments WHERE download_id = ?').run(record.id)
      const insert = this.db.connection.prepare(
        `INSERT INTO engine_download_segments (download_id, idx, start_byte, end_byte, received_bytes)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (const segment of download.segments) {
        insert.run(record.id, segment.index, segment.start, segment.end, segment.receivedBytes)
      }
    })

    try {
      write()
    } catch (error) {
      // A download that cannot be written down is still a download. Losing the
      // ability to resume it after a restart is bad; failing the transfer that
      // is currently working is worse.
      log.warn(`could not persist download ${record.id}`, error)
    }
  }

  remove(id: string): void {
    // The segment rows go with it via ON DELETE CASCADE, which `foreign_keys =
    // ON` in Database.open makes real rather than decorative.
    this.db.connection.prepare('DELETE FROM engine_downloads WHERE id = ?').run(id)
  }

  clearFinished(): void {
    this.db.connection
      .prepare("DELETE FROM engine_downloads WHERE state IN ('completed', 'cancelled', 'failed')")
      .run()
  }

  loadAll(): PersistedDownload[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM engine_downloads ORDER BY started_at DESC')
      .all() as DownloadRow[]

    const segmentRows = this.db.connection
      .prepare('SELECT * FROM engine_download_segments ORDER BY download_id, idx')
      .all() as SegmentRow[]

    const byDownload = new Map<string, Segment[]>()
    for (const row of segmentRows) {
      const list = byDownload.get(row.download_id) ?? []
      list.push({
        index: row.idx,
        start: row.start_byte,
        end: row.end_byte,
        receivedBytes: row.received_bytes
      })
      byDownload.set(row.download_id, list)
    }

    return rows.map((row) => toPersisted(row, byDownload.get(row.id) ?? []))
  }
}

function toPersisted(row: DownloadRow, segments: Segment[]): PersistedDownload {
  return {
    record: {
      id: row.id,
      url: row.url,
      sourceHost: row.source_host,
      filename: row.filename,
      savePath: row.save_path,
      category: row.category as DownloadCategory,
      state: row.state as EngineDownloadState,
      priority: row.priority as DownloadPriority,
      // Defaulted for rows written before queues existed.
      queue: row.queue ?? 'main',
      totalBytes: row.total_bytes,
      receivedBytes: row.received_bytes,
      // Neither survives a restart, and inventing one would put a speed on a
      // download that is not moving.
      bytesPerSecond: 0,
      secondsRemaining: null,
      segments,
      connectionNote: row.connection_note,
      startAfter: row.start_after,
      attempts: row.attempts,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at
    },
    // A row with no validator is a row that cannot be resumed, and saying so
    // here is better than handing back capabilities that claim otherwise.
    capabilities:
      row.etag === null && row.last_modified === null && row.total_bytes === null
        ? null
        : {
            totalBytes: row.total_bytes,
            acceptsRanges: row.accepts_ranges === 1,
            suggestedName: row.suggested_name,
            mimeType: row.mime_type,
            etag: row.etag,
            lastModified: row.last_modified
          },
    segments,
    request: {
      partition: row.partition,
      referer: row.referer,
      origin: row.origin,
      userAgent: row.user_agent
    },
    joinAudioUrl: row.join_audio_url,
    isStream: row.is_stream === 1,
    streamHint:
      row.stream_bandwidth === null && row.stream_quality === null
        ? null
        : { bandwidth: row.stream_bandwidth, quality: row.stream_quality }
  }
}
