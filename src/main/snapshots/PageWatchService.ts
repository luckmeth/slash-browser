import type { WebContents } from 'electron'
import { CHANGE_EXCERPT_CHARS, type PageChange, type WatchedPage } from '@shared/types/watch'
import type { Database } from '../db/Database'
import { createLogger } from '../logger'
import {
  contentHash,
  detectPriceChanges,
  diffText,
  isWorthReporting,
  normaliseForDiff,
  summariseChange
} from './pageDiff'

const log = createLogger('watch')

/** Cap on stored text per page, so a watch list cannot become an archive. */
const MAX_STORED_TEXT = 60_000

interface PageRow {
  id: number
  url: string
  title: string
  added_at: number
  last_checked_at: number | null
  last_hash: string
  last_text: string
}

/**
 * Watches pages for meaningful change.
 *
 * Checked **on visit**, never by polling. A browser re-fetching a list of watched
 * URLs on a timer makes outbound requests nobody asked for and appears in the
 * site's logs as a crawler; checking when the user is already there costs nothing
 * extra and cannot surprise anyone.
 *
 * The comparison itself lives in `pageDiff.ts` and is pure, because deciding what
 * counts as a change worth reporting is the hard part — a watcher that fires on
 * every rotating advert is one the user learns to ignore.
 */
export class PageWatchService {
  constructor(private readonly db: Database) {}

  /** Starts watching a URL. Idempotent. */
  watch(url: string, title: string): void {
    this.db.connection
      .prepare(
        `INSERT INTO watched_pages (url, title, added_at, last_hash, last_text)
         VALUES (@url, @title, @now, '', '')
         ON CONFLICT(url) DO UPDATE SET title = excluded.title`
      )
      .run({ url, title, now: Date.now() })
    log.info(`watching ${url.slice(0, 80)}`)
  }

  /** Stops watching, discarding the stored text and its change history. */
  unwatch(url: string): void {
    // The cascade takes page_changes with it, so nothing is left behind.
    this.db.connection.prepare('DELETE FROM watched_pages WHERE url = ?').run(url)
  }

  isWatching(url: string): boolean {
    return (
      this.db.connection.prepare('SELECT 1 FROM watched_pages WHERE url = ?').get(url) !== undefined
    )
  }

  /**
   * Compares a page against its last known version.
   *
   * Called from the page-load path, so it must be cheap and must never throw into
   * a navigation. The hash short-circuits the common case: an unchanged page costs
   * one comparison and no diffing.
   */
  check(url: string, text: string): PageChange | null {
    const row = this.db.connection
      .prepare(
        'SELECT id, url, title, added_at, last_checked_at, last_hash, last_text FROM watched_pages WHERE url = ?'
      )
      .get(url) as PageRow | undefined
    if (!row) return null

    const normalised = normaliseForDiff(text).slice(0, MAX_STORED_TEXT)
    const hash = contentHash(normalised)
    const now = Date.now()

    // First visit since it was watched: store the baseline, report nothing. There
    // is nothing to compare against, and claiming a change would be a lie.
    if (row.last_hash === '') {
      this.store(row.id, hash, normalised, now)
      return null
    }

    if (hash === row.last_hash) {
      this.db.connection
        .prepare('UPDATE watched_pages SET last_checked_at = ? WHERE id = ?')
        .run(now, row.id)
      return null
    }

    const diff = diffText(row.last_text, normalised)
    const prices = detectPriceChanges(row.last_text, normalised)

    // The text changed but not in a way worth telling anyone about. The baseline
    // still advances, or the same trivial difference would be re-evaluated on
    // every visit forever.
    if (!isWorthReporting(diff, prices)) {
      this.store(row.id, hash, normalised, now)
      return null
    }

    const summary = summariseChange(diff, prices)
    const info = this.db.connection
      .prepare(
        `INSERT INTO page_changes (page_id, at, summary, removed, added, seen)
         VALUES (@pageId, @now, @summary, @removed, @added, 0)`
      )
      .run({
        pageId: row.id,
        now,
        summary,
        removed: diff.removed.join(' ').slice(0, CHANGE_EXCERPT_CHARS),
        added: diff.added.join(' ').slice(0, CHANGE_EXCERPT_CHARS)
      })

    this.store(row.id, hash, normalised, now)
    log.info(`change detected on ${url.slice(0, 60)}: ${summary}`)

    return {
      id: Number(info.lastInsertRowid),
      at: now,
      summary,
      removed: diff.removed.join(' ').slice(0, CHANGE_EXCERPT_CHARS),
      added: diff.added.join(' ').slice(0, CHANGE_EXCERPT_CHARS),
      seen: false
    }
  }

  /** Watched pages with their changes, most recently changed first. */
  list(): WatchedPage[] {
    const pages = this.db.connection
      .prepare(
        `SELECT id, url, title, added_at, last_checked_at, last_hash, last_text
         FROM watched_pages ORDER BY added_at DESC`
      )
      .all() as PageRow[]

    // `seen` is an integer column, so the row shape differs from PageChange —
    // spelled out rather than intersected, which TypeScript reduces to `never`.
    const changes = this.db.connection
      .prepare('SELECT id, page_id, at, summary, removed, added, seen FROM page_changes ORDER BY at DESC')
      .all() as Array<{
      id: number
      page_id: number
      at: number
      summary: string
      removed: string
      added: string
      seen: number
    }>

    const result = pages.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      addedAt: row.added_at,
      lastCheckedAt: row.last_checked_at,
      changes: changes
        .filter((change) => change.page_id === row.id)
        .map(
          (change): PageChange => ({
            id: change.id,
            at: change.at,
            summary: change.summary,
            removed: change.removed,
            added: change.added,
            seen: change.seen === 1
          })
        )
    }))

    // A page that just changed is the one the user came to look at.
    return result.sort(
      (a, b) => (b.changes[0]?.at ?? b.addedAt) - (a.changes[0]?.at ?? a.addedAt)
    )
  }

  unseenCount(): number {
    const row = this.db.connection
      .prepare('SELECT COUNT(*) AS count FROM page_changes WHERE seen = 0')
      .get() as { count: number }
    return row.count
  }

  markAllSeen(): void {
    this.db.connection.prepare('UPDATE page_changes SET seen = 1 WHERE seen = 0').run()
  }

  /** Extracts a page's text and checks it. Safe to call from a page load. */
  async checkPage(contents: WebContents | null, url: string): Promise<PageChange | null> {
    if (!contents || contents.isDestroyed() || !this.isWatching(url)) return null
    try {
      const text = (await contents.executeJavaScript(
        "(document.querySelector('main, article, [role=\"main\"]') || document.body).innerText",
        true
      )) as string
      return typeof text === 'string' ? this.check(url, text) : null
    } catch (error) {
      // A page that refuses extraction is not a change; it is unreadable.
      log.debug('watch extraction failed', error)
      return null
    }
  }

  private store(id: number, hash: string, text: string, now: number): void {
    this.db.connection
      .prepare(
        'UPDATE watched_pages SET last_hash = ?, last_text = ?, last_checked_at = ? WHERE id = ?'
      )
      .run(hash, text, now, id)
  }
}
