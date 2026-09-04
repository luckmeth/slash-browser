import { getLoadablePath } from 'sqlite-vec'
import { SEMANTIC_DIMENSIONS, SEMANTIC_MODEL_ID } from '@shared/types/semantic'
import type { Database } from '../Database'
import { createLogger } from '../../logger'

const log = createLogger('semantic')

export interface VectorHit {
  chunkId: number
  pageId: number
  text: string
  /** Cosine distance from sqlite-vec: 0 is identical. */
  distance: number
}

export interface PendingPage {
  pageId: number
  url: string
  title: string
  siteName: string | null
  excerpt: string
  body: string
}

/**
 * The vector half of the memory index.
 *
 * Inert until `enable()` succeeds. Every method is safe to call before then and
 * does nothing, which is what lets the rest of the browser treat semantic search
 * as a bonus rather than a dependency — no caller has to ask whether the feature
 * exists before deleting a page.
 *
 * Two facts about sqlite-vec 0.1.9 shape this file:
 *
 *  - vec0 rowids must be bound as **BigInt**. better-sqlite3 hands a plain JS
 *    number to SQLite as a float, and vec0 rejects a non-integer primary key
 *    with "Only integers are allows for primary key values". A `Number` binding
 *    here fails every insert.
 *  - vec0 carries no foreign keys, so `ON DELETE CASCADE` from `memory_pages`
 *    reaches `memory_chunks` but never the vectors. They are deleted explicitly,
 *    always before the rows they are keyed to.
 */
export class VectorStore {
  private available = false
  private lastError: string | null = null

  constructor(private readonly db: Database) {}

  get isAvailable(): boolean {
    return this.available
  }

  get failureReason(): string | null {
    return this.lastError
  }

  /**
   * Loads the extension and creates the vector table.
   *
   * Idempotent, and reports failure as a value: a machine without the platform
   * package, or with a blocked DLL load, gets keyword search and an honest
   * message rather than an exception on a code path it did not ask for.
   */
  enable(): boolean {
    if (this.available) return true

    let loadablePath: string
    try {
      // Throws on a platform sqlite-vec has no prebuilt binary for. The module
      // itself is inert on import, so only the resolution needs guarding.
      loadablePath = unpackedPath(getLoadablePath())
    } catch (error) {
      this.lastError = 'The vector extension is not available for this platform.'
      log.warn('sqlite-vec could not be resolved', error)
      return false
    }

    if (!this.db.loadExtension(loadablePath)) {
      this.lastError = 'The vector extension could not be loaded on this machine.'
      return false
    }

    try {
      this.db.connection.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
           embedding FLOAT[${SEMANTIC_DIMENSIONS}] distance_metric=cosine
         )`
      )
    } catch (error) {
      this.lastError = 'The vector index could not be created.'
      log.error('failed to create memory_vectors', error)
      return false
    }

    this.available = true
    this.lastError = null
    log.info('vector index ready')
    this.pruneOrphans()
    return true
  }

  /**
   * Replaces everything stored for one page, in a single transaction.
   *
   * Replace rather than append, for the same reason the FTS index is replaced:
   * a re-indexed page whose old passages linger keeps matching text it no longer
   * contains, and the user has no way to tell that is what happened.
   */
  storePage(
    pageId: number,
    chunks: readonly string[],
    vectors: readonly Float32Array[],
    contentHash: string
  ): void {
    if (!this.available) return
    if (chunks.length !== vectors.length) {
      throw new Error('Chunk and vector counts disagree; refusing to store a misaligned page')
    }

    const write = this.db.connection.transaction(() => {
      this.deleteVectorsForPage(pageId)
      this.db.connection.prepare('DELETE FROM memory_chunks WHERE page_id = ?').run(pageId)

      const insertChunk = this.db.connection.prepare(
        'INSERT INTO memory_chunks (page_id, ordinal, text) VALUES (?, ?, ?)'
      )
      const insertVector = this.db.connection.prepare(
        'INSERT INTO memory_vectors (rowid, embedding) VALUES (?, ?)'
      )

      chunks.forEach((text, ordinal) => {
        const vector = vectors[ordinal]
        if (!vector) return
        const info = insertChunk.run(pageId, ordinal, text)
        // BigInt, not Number — see the class comment.
        insertVector.run(BigInt(info.lastInsertRowid), toBlob(vector))
      })

      this.db.connection
        .prepare(
          `INSERT INTO memory_embedded_pages (page_id, model, content_hash, chunk_count, embedded_at)
           VALUES (@pageId, @model, @hash, @count, @now)
           ON CONFLICT(page_id) DO UPDATE SET
             model        = excluded.model,
             content_hash = excluded.content_hash,
             chunk_count  = excluded.chunk_count,
             embedded_at  = excluded.embedded_at`
        )
        .run({
          pageId,
          model: SEMANTIC_MODEL_ID,
          hash: contentHash,
          count: chunks.length,
          now: Date.now()
        })
    })

    write()
  }

  /**
   * Records that a page is up to date without re-embedding it.
   *
   * A page re-visited with unchanged text still bumps `indexed_at`, which would
   * otherwise make it look pending forever and re-embed it on every visit.
   */
  touch(pageId: number): void {
    if (!this.available) return
    this.db.connection
      .prepare('UPDATE memory_embedded_pages SET embedded_at = ? WHERE page_id = ?')
      .run(Date.now(), pageId)
  }

  /** The stored hash for a page, or null if it has never been embedded. */
  contentHashFor(pageId: number): string | null {
    if (!this.available) return null
    const row = this.db.connection
      .prepare('SELECT content_hash FROM memory_embedded_pages WHERE page_id = ? AND model = ?')
      .get(pageId, SEMANTIC_MODEL_ID) as { content_hash: string } | undefined
    return row?.content_hash ?? null
  }

  /**
   * Nearest passages to a query vector.
   *
   * `k` is asked of vec0 directly rather than by over-fetching and sorting:
   * the extension's own top-k is what makes this a scan of the index instead of
   * a scan of every vector.
   */
  search(query: Float32Array, k: number): VectorHit[] {
    if (!this.available) return []
    try {
      return this.db.connection
        .prepare(
          `SELECT v.rowid AS chunk_id, c.page_id, c.text, v.distance
           FROM memory_vectors v
           JOIN memory_chunks c ON c.id = v.rowid
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY v.distance`
        )
        .all(toBlob(query), k)
        .map((row) => {
          const typed = row as { chunk_id: number; page_id: number; text: string; distance: number }
          return {
            chunkId: typed.chunk_id,
            pageId: typed.page_id,
            text: typed.text,
            distance: typed.distance
          }
        })
    } catch (error) {
      // A failed vector search must not take the keyword results down with it.
      log.error('vector search failed', error)
      return []
    }
  }

  /**
   * Pages with text but no current vectors, most recent first.
   *
   * Recent first because that is the order the user will search in: a backfill
   * interrupted after a hundred pages should have covered the hundred most
   * likely to be looked for, not the hundred oldest.
   */
  pendingPages(limit: number): PendingPage[] {
    if (!this.available) return []
    return this.db.connection
      .prepare(
        `SELECT p.id AS page_id, p.url, p.title, p.site_name, p.excerpt,
                COALESCE(f.body, '') AS body
         FROM memory_pages p
         LEFT JOIN memory_embedded_pages e ON e.page_id = p.id AND e.model = @model
         LEFT JOIN memory_fts f ON f.page_id = p.id
         WHERE e.page_id IS NULL OR p.indexed_at > e.embedded_at
         ORDER BY p.visited_at DESC
         LIMIT @limit`
      )
      .all({ model: SEMANTIC_MODEL_ID, limit })
      .map((row) => {
        const typed = row as {
          page_id: number
          url: string
          title: string
          site_name: string | null
          excerpt: string
          body: string
        }
        return {
          pageId: typed.page_id,
          url: typed.url,
          title: typed.title,
          siteName: typed.site_name,
          excerpt: typed.excerpt,
          body: typed.body
        }
      })
  }

  /** How much is embedded and how much is outstanding. */
  counts(): { embedded: number; pending: number } {
    if (!this.available) return { embedded: 0, pending: 0 }
    const row = this.db.connection
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM memory_embedded_pages WHERE model = @model) AS embedded,
           (SELECT COUNT(*)
              FROM memory_pages p
              LEFT JOIN memory_embedded_pages e ON e.page_id = p.id AND e.model = @model
              WHERE e.page_id IS NULL OR p.indexed_at > e.embedded_at) AS pending`
      )
      .get({ model: SEMANTIC_MODEL_ID }) as { embedded: number; pending: number }
    return row
  }

  /**
   * Removes everything derived from one page.
   *
   * Called by `MemoryRepository` *before* the page row is deleted, because the
   * chunk rows the vectors are keyed to disappear with it.
   */
  forgetPage(pageId: number): void {
    if (!this.available) return
    const drop = this.db.connection.transaction(() => {
      this.deleteVectorsForPage(pageId)
      this.db.connection.prepare('DELETE FROM memory_chunks WHERE page_id = ?').run(pageId)
      this.db.connection.prepare('DELETE FROM memory_embedded_pages WHERE page_id = ?').run(pageId)
    })
    drop()
  }

  clearAll(): void {
    if (!this.available) return
    const wipe = this.db.connection.transaction(() => {
      this.db.connection.exec('DELETE FROM memory_vectors')
      this.db.connection.exec('DELETE FROM memory_chunks')
      this.db.connection.exec('DELETE FROM memory_embedded_pages')
    })
    try {
      wipe()
      log.info('vector index cleared')
    } catch (error) {
      log.error('failed to clear the vector index', error)
    }
  }

  /**
   * Drops vectors whose chunk row is gone.
   *
   * This is the repair path for the one hole in the design: if a page is
   * forgotten during a session where the extension never loaded, the cascade
   * takes the chunks and leaves the vectors behind. They are harmless — every
   * query joins through `memory_chunks`, so an orphan can never surface as a
   * result — but they are page-derived data the user asked to be rid of, so they
   * go at the first opportunity.
   */
  private pruneOrphans(): void {
    try {
      const orphans = this.db.connection
        .prepare(
          `SELECT v.rowid AS id FROM memory_vectors v
           LEFT JOIN memory_chunks c ON c.id = v.rowid
           WHERE c.id IS NULL`
        )
        .all() as Array<{ id: number }>
      if (orphans.length === 0) return

      const remove = this.db.connection.prepare('DELETE FROM memory_vectors WHERE rowid = ?')
      const drop = this.db.connection.transaction(() => {
        for (const orphan of orphans) remove.run(BigInt(orphan.id))
      })
      drop()
      log.info(`removed ${orphans.length} orphaned vector(s)`)
    } catch (error) {
      log.warn('could not prune orphaned vectors', error)
    }
  }

  private deleteVectorsForPage(pageId: number): void {
    const ids = this.db.connection
      .prepare('SELECT id FROM memory_chunks WHERE page_id = ?')
      .all(pageId) as Array<{ id: number }>
    if (ids.length === 0) return
    const remove = this.db.connection.prepare('DELETE FROM memory_vectors WHERE rowid = ?')
    for (const row of ids) remove.run(BigInt(row.id))
  }
}

/**
 * Redirects a resolved module path out of `app.asar` and into `app.asar.unpacked`.
 *
 * Electron patches `require`, `fs` and friends so that reading an unpacked file
 * through the asar path transparently works — which is why better-sqlite3's own
 * `.node` binary loads without anyone thinking about it. `loadExtension` gets no
 * such help: it hands the string to SQLite, which opens the DLL through the OS
 * with no idea that asar exists. `require.resolve` therefore returns a path that
 * is correct for every consumer except this one.
 *
 * Found by running the packaged build rather than the dev build — in dev there
 * is no archive and the bug does not exist.
 */
function unpackedPath(resolved: string): string {
  return resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/**
 * Float32Array → the little-endian float blob vec0 expects.
 *
 * `subarray` views share the parent buffer, so the byte offset and length must
 * be passed explicitly — `Buffer.from(view.buffer)` would silently write the
 * whole batch into every row.
 */
function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}
