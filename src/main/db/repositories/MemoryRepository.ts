import type { ExtractedPage, MemoryResult, MemoryStats, ParsedQuery } from '@shared/types/memory'
import type { Database } from '../Database'
import type { VectorStore } from './VectorStore'
import { toFtsQuery } from '../../memory/parseQuery'
import { createLogger } from '../../logger'

const log = createLogger('memory')

interface ResultRow {
  page_id: number
  url: string
  title: string
  site_name: string | null
  excerpt: string
  visited_at: number
  score: number
  snippet: string | null
}

/** A page row without any search scoring, for hydrating a semantic-only hit. */
export interface MemoryPageRow {
  pageId: number
  url: string
  title: string
  siteName: string | null
  excerpt: string
  visitedAt: number
}

export class MemoryRepository {
  /**
   * The vector half of the index, when it exists.
   *
   * Held here rather than left to a caller because deletion is the one thing
   * that must not be optional: `ON DELETE CASCADE` reaches the chunk rows but
   * cannot reach a vec0 virtual table, so forgetting a page has to remove its
   * vectors first. Making that a separate call some caller might forget is how
   * "delete everything" ends up leaving something behind.
   */
  private vectors: VectorStore | null = null

  constructor(private readonly db: Database) {}

  attachVectorStore(vectors: VectorStore): void {
    this.vectors = vectors
  }

  /**
   * Stores or refreshes a page, returning its id.
   *
   * `withContent` false records only title and URL — the state when the user has
   * enabled history indexing but not content indexing. Those are separate
   * settings because they are genuinely different levels of exposure.
   */
  upsert(page: ExtractedPage, visitedAt: number, withContent: boolean): number {
    const body = withContent ? page.body : ''

    const write = this.db.connection.transaction((): number => {
      this.db.connection
        .prepare(
          `INSERT INTO memory_pages
             (url, title, site_name, excerpt, word_count, has_content, indexed_at, visited_at)
           VALUES (@url, @title, @siteName, @excerpt, @wordCount, @hasContent, @now, @visitedAt)
           ON CONFLICT(url) DO UPDATE SET
             title       = excluded.title,
             site_name   = COALESCE(excluded.site_name, site_name),
             excerpt     = excluded.excerpt,
             word_count  = excluded.word_count,
             has_content = excluded.has_content,
             indexed_at  = excluded.indexed_at,
             visited_at  = excluded.visited_at`
        )
        .run({
          url: page.url,
          title: page.title,
          siteName: page.siteName,
          excerpt: withContent ? page.excerpt : '',
          wordCount: withContent ? page.wordCount : 0,
          hasContent: withContent ? 1 : 0,
          now: Date.now(),
          visitedAt
        })

      const row = this.db.connection
        .prepare('SELECT id FROM memory_pages WHERE url = ?')
        .get(page.url) as { id: number }

      // Replace rather than append: re-indexing a page must not leave the old
      // text searchable, or a since-edited page keeps matching stale terms.
      this.db.connection.prepare('DELETE FROM memory_fts WHERE page_id = ?').run(row.id)
      this.db.connection
        .prepare('INSERT INTO memory_fts (title, body, url, page_id) VALUES (?, ?, ?, ?)')
        .run(page.title, body, page.url, row.id)

      return row.id
    })

    return write()
  }

  /** Page metadata by id, for results that only the vector index found. */
  pagesByIds(ids: readonly number[]): Map<number, MemoryPageRow> {
    const found = new Map<number, MemoryPageRow>()
    if (ids.length === 0) return found

    // Built from the ids' own count rather than a fixed IN list: they come from
    // our own index, never from the user, and every one is bound.
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.connection
      .prepare(
        `SELECT id AS page_id, url, title, site_name, excerpt, visited_at
         FROM memory_pages WHERE id IN (${placeholders})`
      )
      .all(...ids) as ResultRow[]

    for (const row of rows) {
      found.set(row.page_id, {
        pageId: row.page_id,
        url: row.url,
        title: row.title,
        siteName: row.site_name,
        excerpt: row.excerpt,
        visitedAt: row.visited_at
      })
    }
    return found
  }

  /**
   * Full-text search, ordered by BM25.
   *
   * BM25 returns a *negative* score where more negative is a better match, which
   * is SQLite's convention. It is flipped on the way out so callers can treat
   * higher as better without knowing that.
   */
  search(parsed: ParsedQuery, limit: number): MemoryResult[] {
    const expression = toFtsQuery(parsed.terms)

    // A query that was only a time expression ("yesterday") is legitimate: it
    // means "everything from then", so fall back to a time-ordered listing.
    if (expression === '') {
      if (parsed.after === null && parsed.before === null) return []
      return this.byTimeWindow(parsed, limit)
    }

    const clauses: string[] = ['memory_fts MATCH @expression']
    if (parsed.after !== null) clauses.push('p.visited_at >= @after')
    if (parsed.before !== null) clauses.push('p.visited_at < @before')

    try {
      const rows = this.db.connection
        .prepare(
          `SELECT p.id AS page_id, p.url, p.title, p.site_name, p.excerpt, p.visited_at,
                  bm25(memory_fts, 8.0, 1.0, 4.0) AS score,
                  snippet(memory_fts, 1, '<<', '>>', '…', 24) AS snippet
           FROM memory_fts
           JOIN memory_pages p ON p.id = memory_fts.page_id
           WHERE ${clauses.join(' AND ')}
           ORDER BY score
           LIMIT @limit`
        )
        .all({
          expression,
          after: parsed.after,
          before: parsed.before,
          limit
        }) as ResultRow[]

      return rows.map((row) => toResult(row, parsed))
    } catch (error) {
      // A malformed MATCH expression is a bug in our escaping, not something the
      // user should see as a crash.
      log.error('full-text search failed', error)
      return []
    }
  }

  private byTimeWindow(parsed: ParsedQuery, limit: number): MemoryResult[] {
    const clauses: string[] = []
    if (parsed.after !== null) clauses.push('visited_at >= @after')
    if (parsed.before !== null) clauses.push('visited_at < @before')

    const rows = this.db.connection
      .prepare(
        `SELECT id AS page_id, url, title, site_name, excerpt, visited_at,
                0 AS score, NULL AS snippet
         FROM memory_pages
         ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY visited_at DESC
         LIMIT @limit`
      )
      .all({ after: parsed.after, before: parsed.before, limit }) as ResultRow[]

    return rows.map((row) => toResult(row, parsed))
  }

  stats(semanticAvailable: boolean, semanticEnabled: boolean): MemoryStats {
    const counts = this.db.connection
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(has_content), 0) AS with_content,
                MIN(indexed_at) AS oldest
         FROM memory_pages`
      )
      .get() as { total: number; with_content: number; oldest: number | null }

    return {
      pageCount: counts.total,
      withContent: counts.with_content,
      oldestIndexedAt: counts.oldest,
      semanticAvailable,
      semanticEnabled
    }
  }

  forget(url: string): void {
    const row = this.db.connection.prepare('SELECT id FROM memory_pages WHERE url = ?').get(url) as
      | { id: number }
      | undefined
    if (!row) return
    // Vectors first: they are keyed to chunk rows that the page's cascade is
    // about to delete, and once those are gone there is nothing left to find
    // them by.
    this.vectors?.forgetPage(row.id)
    const remove = this.db.connection.transaction(() => {
      this.db.connection.prepare('DELETE FROM memory_fts WHERE page_id = ?').run(row.id)
      this.db.connection.prepare('DELETE FROM memory_pages WHERE id = ?').run(row.id)
    })
    remove()
  }

  clearAll(): void {
    this.vectors?.clearAll()
    const wipe = this.db.connection.transaction(() => {
      this.db.connection.prepare('DELETE FROM memory_fts').run()
      this.db.connection.prepare('DELETE FROM memory_pages').run()
    })
    wipe()
    log.info('memory index cleared')
  }

  /** Drops content older than the retention window, keeping nothing behind. */
  pruneOlderThan(cutoff: number): number {
    const rows = this.db.connection
      .prepare('SELECT id FROM memory_pages WHERE visited_at < ?')
      .all(cutoff) as Array<{ id: number }>
    if (rows.length === 0) return 0

    for (const row of rows) this.vectors?.forgetPage(row.id)
    const remove = this.db.connection.transaction(() => {
      const dropFts = this.db.connection.prepare('DELETE FROM memory_fts WHERE page_id = ?')
      const dropPage = this.db.connection.prepare('DELETE FROM memory_pages WHERE id = ?')
      for (const row of rows) {
        dropFts.run(row.id)
        dropPage.run(row.id)
      }
    })
    remove()
    log.info(`pruned ${rows.length} page(s) past the retention window`)
    return rows.length
  }
}

function toResult(row: ResultRow, parsed: ParsedQuery): MemoryResult {
  const reasons: MemoryResult['reasons'] = []

  if (row.snippet) {
    const matched = [...row.snippet.matchAll(/<<(.+?)>>/g)].map((match) => match[1])
    if (matched.length > 0) {
      reasons.push({
        kind: 'keyword',
        detail: `matched ${[...new Set(matched)].slice(0, 4).join(', ')}`
      })
    }
  }

  const terms = parsed.terms.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.some((term) => row.title.toLowerCase().includes(term))) {
    reasons.push({ kind: 'title', detail: 'words appear in the title' })
  }
  if (terms.some((term) => row.url.toLowerCase().includes(term))) {
    reasons.push({ kind: 'url', detail: 'words appear in the address' })
  }
  if (parsed.timeLabel) {
    reasons.push({ kind: 'recency', detail: `visited ${parsed.timeLabel}` })
  }

  return {
    pageId: row.page_id,
    url: row.url,
    title: row.title,
    siteName: row.site_name,
    // Strip the FTS markers; the UI highlights from `reasons` instead of
    // rendering raw markup, which would be an injection vector.
    snippet: (row.snippet ?? row.excerpt).replace(/<<|>>/g, ''),
    visitedAt: row.visited_at,
    // BM25 is negative-better; flip it so higher is better for callers.
    score: -row.score,
    reasons
  }
}
