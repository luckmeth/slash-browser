import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PersistedDownload } from '@shared/types/downloadEngine'
import { migrations } from '../migrations'
import type { Database } from '../Database'
import { EngineDownloadRepository } from './EngineDownloadRepository'

/**
 * Against a real in-memory SQLite, running the real migrations.
 *
 * The sibling `ClosedTabRepository` test uses a fake connection, and its
 * reasoning is sound for what it covers: ordering and a row limit are ours to
 * verify, and better-sqlite3 is not. This one is different. What is being
 * checked here *is* SQL — a migration that must apply cleanly, an upsert that
 * must not lose columns it does not name, a transaction that must keep a record
 * and its segments in step, and an `ON DELETE CASCADE` that only exists if
 * `foreign_keys` is actually on. A fake connection would assert that the
 * strings we wrote are the strings we wrote.
 */
function openTestDatabase(): { db: Database; raw: BetterSqlite3.Database } {
  const raw = new BetterSqlite3(':memory:')
  raw.pragma('foreign_keys = ON')
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    raw.exec(migration.sql)
  }
  return { db: { connection: raw } as unknown as Database, raw }
}

const download = (over: Partial<PersistedDownload> = {}): PersistedDownload => ({
  record: {
    id: 'dl-1',
    url: 'https://example.test/film.mp4',
    sourceHost: 'example.test',
    filename: 'film.mp4',
    savePath: 'C:/Downloads/film.mp4',
    category: 'video',
    state: 'downloading',
    priority: 'normal',
  queue: 'main',
    totalBytes: 1000,
    receivedBytes: 400,
    bytesPerSecond: 1234,
    secondsRemaining: 12,
    segments: [
      { index: 0, start: 0, end: 499, receivedBytes: 400 },
      { index: 1, start: 500, end: 999, receivedBytes: 0 }
    ],
    connectionNote: '2 connections',
    startAfter: null,
    attempts: 1,
    error: null,
    startedAt: 1_700_000_000_000,
    completedAt: null
  },
  capabilities: {
    totalBytes: 1000,
    acceptsRanges: true,
    suggestedName: 'film.mp4',
    mimeType: 'video/mp4',
    etag: '"abc"',
    lastModified: null
  },
  segments: [
    { index: 0, start: 0, end: 499, receivedBytes: 400 },
    { index: 1, start: 500, end: 999, receivedBytes: 0 }
  ],
  request: {
    partition: 'default',
    referer: 'https://example.test/watch',
    origin: 'https://example.test',
    userAgent: 'Slash/1.0'
  },
  joinAudioUrl: null,
  isStream: false,
  streamHint: null,
  ...over
})

describe('EngineDownloadRepository', () => {
  let repository: EngineDownloadRepository
  let raw: BetterSqlite3.Database

  beforeEach(() => {
    const opened = openTestDatabase()
    raw = opened.raw
    repository = new EngineDownloadRepository(opened.db)
  })

  afterEach(() => {
    raw.close()
  })

  it('applies migration 24 cleanly on top of every earlier one', () => {
    // The migration is forward-only and irreversible. If it does not apply, the
    // browser does not open — the whole database is taken with it.
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
    const names = tables.map((row) => row.name)
    expect(names).toContain('engine_downloads')
    expect(names).toContain('engine_download_segments')
    // The pre-existing table must still be there and untouched.
    expect(names).toContain('downloads')
  })

  it('stores a download and reads it back unchanged', () => {
    const saved = download()
    repository.save(saved)

    const loaded = repository.loadAll()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.record.id).toBe('dl-1')
    expect(loaded[0]?.record.filename).toBe('film.mp4')
    expect(loaded[0]?.record.savePath).toBe('C:/Downloads/film.mp4')
    expect(loaded[0]?.record.totalBytes).toBe(1000)
    expect(loaded[0]?.record.receivedBytes).toBe(400)
    expect(loaded[0]?.capabilities?.etag).toBe('"abc"')
    expect(loaded[0]?.capabilities?.acceptsRanges).toBe(true)
  })

  it('keeps the segment table, which is what makes resuming possible', () => {
    repository.save(download())
    const loaded = repository.loadAll()[0]
    expect(loaded?.segments).toEqual([
      { index: 0, start: 0, end: 499, receivedBytes: 400 },
      { index: 1, start: 500, end: 999, receivedBytes: 0 }
    ])
  })

  it('never reports a speed or an ETA for a restored download', () => {
    // Both describe a transfer that is moving. A restored one is not, and a
    // stored "1.2 MB/s" beside a stopped download is simply a lie.
    repository.save(download())
    const loaded = repository.loadAll()[0]
    expect(loaded?.record.bytesPerSecond).toBe(0)
    expect(loaded?.record.secondsRemaining).toBeNull()
  })

  it('updates progress in place rather than accumulating rows', () => {
    repository.save(download())
    repository.save(
      download({
        record: { ...download().record, receivedBytes: 900, state: 'paused' },
        segments: [
          { index: 0, start: 0, end: 499, receivedBytes: 500 },
          { index: 1, start: 500, end: 999, receivedBytes: 400 }
        ]
      })
    )

    const loaded = repository.loadAll()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.record.receivedBytes).toBe(900)
    expect(loaded[0]?.record.state).toBe('paused')
  })

  it('replaces the segment table wholesale instead of merging it', () => {
    // A plan of four connections re-probed as two must not leave two orphaned
    // segments behind, or the resumed download reads offsets for a file layout
    // that no longer exists.
    repository.save(download())
    repository.save(
      download({ segments: [{ index: 0, start: 0, end: 999, receivedBytes: 700 }] })
    )
    expect(repository.loadAll()[0]?.segments).toHaveLength(1)
  })

  it('deletes segments with their download', () => {
    repository.save(download())
    repository.remove('dl-1')
    expect(repository.loadAll()).toHaveLength(0)
    const orphans = raw.prepare('SELECT COUNT(*) AS n FROM engine_download_segments').get() as {
      n: number
    }
    expect(orphans.n).toBe(0)
  })

  it('clears finished downloads and keeps unfinished ones', () => {
    repository.save(download({ record: { ...download().record, id: 'a', state: 'completed' } }))
    repository.save(download({ record: { ...download().record, id: 'b', state: 'failed' } }))
    repository.save(download({ record: { ...download().record, id: 'c', state: 'cancelled' } }))
    repository.save(download({ record: { ...download().record, id: 'd', state: 'paused' } }))

    repository.clearFinished()
    expect(repository.loadAll().map((entry) => entry.record.id)).toEqual(['d'])
  })

  it('stores a session partition by name and no credential of any kind', () => {
    repository.save(download())
    const row = raw.prepare('SELECT * FROM engine_downloads WHERE id = ?').get('dl-1') as Record<
      string,
      unknown
    >
    expect(row['partition']).toBe('default')
    expect(row['referer']).toBe('https://example.test/watch')
    // There is no column for any of these, and there must not be: a cookie in a
    // database row is a live credential outliving the tab it came from.
    expect(Object.keys(row)).not.toContain('cookie')
    expect(Object.keys(row)).not.toContain('cookies')
    expect(Object.keys(row)).not.toContain('authorization')
  })

  it('keeps a two-part download’s audio URL and stream hint', () => {
    repository.save(
      download({
        joinAudioUrl: 'https://example.test/audio.m4a',
        isStream: true,
        streamHint: { bandwidth: 5_200_000, quality: '1920x1080' }
      })
    )
    const loaded = repository.loadAll()[0]
    expect(loaded?.joinAudioUrl).toBe('https://example.test/audio.m4a')
    expect(loaded?.isStream).toBe(true)
    expect(loaded?.streamHint).toEqual({ bandwidth: 5_200_000, quality: '1920x1080' })
  })

  it('reports no capabilities when the server offered nothing to resume against', () => {
    // Distinct from "capabilities we did not store". A download with no
    // validator and no length cannot be continued, and saying so on load is
    // what makes the queue start it again cleanly.
    repository.save(
      download({
        capabilities: null,
        record: { ...download().record, totalBytes: null }
      })
    )
    expect(repository.loadAll()[0]?.capabilities).toBeNull()
  })

  it('orders newest first, like the list the user sees', () => {
    repository.save(
      download({ record: { ...download().record, id: 'old', startedAt: 1_000 } })
    )
    repository.save(
      download({ record: { ...download().record, id: 'new', startedAt: 9_000 } })
    )
    expect(repository.loadAll().map((entry) => entry.record.id)).toEqual(['new', 'old'])
  })

  it('survives a failed write rather than taking the download with it', () => {
    // A download that cannot be written down is still a download in progress.
    repository.save(download())
    raw.exec('DROP TABLE engine_download_segments')
    expect(() => repository.save(download())).not.toThrow()
  })
})
