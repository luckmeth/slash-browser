import { createHash } from 'node:crypto'
import {
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL_LABEL,
  type SemanticState,
  type SemanticStatus
} from '@shared/types/semantic'
import type { PendingPage, VectorHit, VectorStore } from '../../db/repositories/VectorStore'
import type { SettingsStore } from '../../settings/SettingsStore'
import { createLogger } from '../../logger'
import { chunkPage } from './chunking'
import { UtilityProcessEmbedder } from './UtilityProcessEmbedder'

const log = createLogger('semantic')

/** Pages per backfill batch, and the pause between batches. */
const BACKFILL_BATCH = 5
const BACKFILL_PAUSE_MS = 100

/**
 * Owns the optional semantic layer end to end.
 *
 * The whole class is written around one rule: **nothing here may ever be on the
 * critical path.** Searching with the model still loading returns keyword
 * results and no error. A backfill runs in batches with the process yielding in
 * between. A worker crash disables the layer and leaves the browser untouched.
 * If this file were deleted, memory search would keep working.
 */
export class SemanticIndex {
  private embedder: UtilityProcessEmbedder | null = null
  private state: SemanticState = 'off'
  private detail = ''
  private backfilling = false
  private backfillTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly vectors: VectorStore,
    private readonly settings: SettingsStore,
    /** Directory holding the bundled model files. See resources/models/. */
    private readonly modelsDir: string,
    private readonly onStatusChanged: (status: SemanticStatus) => void
  ) {}

  /**
   * Brings the layer up or down to match the setting.
   *
   * Called at startup and on every settings change, so the switch in the UI is
   * the single source of truth — there is no separate "start" the user could
   * leave in a state that disagrees with what the toggle says.
   */
  syncWithSettings(): void {
    if (this.settings.getAll().semanticSearchEnabled) void this.enable()
    else void this.disable()
  }

  /**
   * Turns the layer on: vector table, then model, then backfill.
   *
   * Each step reports its own failure, because they fail for genuinely different
   * reasons and "semantic search is unavailable" would be useless to someone
   * trying to work out whether to retry, reinstall, or give up.
   */
  async enable(): Promise<void> {
    if (this.stopped) return
    if (this.state === 'preparing' || this.state === 'indexing' || this.state === 'ready') return

    if (!this.vectors.enable()) {
      this.publish(
        'unsupported',
        `${this.vectors.failureReason ?? 'The vector index is unavailable.'} ` +
          'Keyword search is unaffected.'
      )
      return
    }

    this.publish('preparing', `Loading ${SEMANTIC_MODEL_LABEL}…`)

    this.embedder = new UtilityProcessEmbedder(this.modelsDir)

    try {
      await this.embedder.prepare()
    } catch (error) {
      this.embedder = null
      // The library's own message names internal flags and a resolved file path.
      // That belongs in the log, not in a panel: the only actionable thing a
      // user can take from it is that their installation is damaged.
      log.error('the embedding model failed to load', error)
      this.publish(
        'error',
        'The embedding model could not be loaded — the files that ship with Slash look ' +
          'missing or damaged, and it will not go to the network to replace them. ' +
          'Reinstalling should fix it. Keyword search is unaffected.'
      )
      return
    }

    this.publish('ready', 'Ready. Nothing you search for leaves this machine.')
    this.scheduleBackfill(0)
  }

  /**
   * Switches the layer off and stops the worker.
   *
   * Vectors and passages are deliberately kept. They were derived from pages the
   * user already chose to index, re-embedding a large history costs minutes of
   * CPU, and the memory panel's "delete everything indexed" removes them along
   * with everything else — which is where a user looks to delete things.
   */
  async disable(): Promise<void> {
    if (this.backfillTimer) clearTimeout(this.backfillTimer)
    this.backfillTimer = null

    const embedder = this.embedder
    this.embedder = null
    await embedder?.dispose()

    if (this.state !== 'unsupported') {
      this.publish('off', 'Semantic search is off. Memory search uses keywords only.')
    }
  }

  /**
   * Queues one page for embedding after it has been indexed.
   *
   * Fire-and-forget by design: this is called from the page-load path, and the
   * page must not wait on a model to finish loading.
   */
  notePageIndexed(): void {
    if (!this.isUsable()) return
    this.scheduleBackfill(BACKFILL_PAUSE_MS)
  }

  /**
   * Nearest passages to a query.
   *
   * Returns nothing rather than waiting when the model is not loaded — a query
   * typed while a 25 MB download is in flight gets keyword results now, not
   * better results in two minutes.
   */
  async search(query: string, k: number): Promise<VectorHit[]> {
    if (!this.isUsable() || !this.embedder?.isReady) return []
    const trimmed = query.trim()
    if (trimmed === '') return []

    try {
      const [vector] = await this.embedder.embed([trimmed])
      if (!vector) return []
      return this.vectors.search(vector, k)
    } catch (error) {
      log.warn('semantic search failed; keyword results stand alone', error)
      return []
    }
  }

  status(): SemanticStatus {
    const counts = this.vectors.isAvailable
      ? this.vectors.counts()
      : { embedded: 0, pending: 0 }
    return {
      state: this.state,
      modelLabel: SEMANTIC_MODEL_LABEL,
      dimensions: SEMANTIC_DIMENSIONS,
      embeddedPages: counts.embedded,
      pendingPages: counts.pending,
      detail: this.detail
    }
  }

  /** Whether a search may consult the vector index right now. */
  isUsable(): boolean {
    return (this.state === 'ready' || this.state === 'indexing') && this.vectors.isAvailable
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.disable()
  }

  private scheduleBackfill(delayMs: number): void {
    if (this.stopped || this.backfilling || this.backfillTimer) return
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null
      void this.runBackfill()
    }, delayMs)
  }

  /**
   * Embeds outstanding pages a batch at a time.
   *
   * The pause between batches is the point of the loop: a fresh profile with
   * three thousand indexed pages would otherwise saturate a core for a minute
   * on the first launch after enabling, which is exactly the kind of cost a
   * background feature is not allowed to impose.
   */
  private async runBackfill(): Promise<void> {
    if (this.backfilling || !this.isUsable() || !this.embedder) return
    this.backfilling = true

    try {
      const pending = this.vectors.pendingPages(BACKFILL_BATCH)
      if (pending.length === 0) {
        if (this.state !== 'ready') this.publish('ready', 'Every indexed page is searchable by meaning.')
        return
      }

      const remaining = this.vectors.counts().pending
      this.publish(
        'indexing',
        `Reading ${remaining.toLocaleString()} page${remaining === 1 ? '' : 's'} you have already visited. Search works throughout.`
      )

      for (const page of pending) {
        if (this.stopped || !this.embedder) return
        await this.embedPage(page)
      }
    } catch (error) {
      log.warn('backfill batch failed', error)
    } finally {
      this.backfilling = false
      // Only reschedule if there is more to do; an empty queue leaves the loop
      // idle rather than waking every hundred milliseconds forever.
      if (!this.stopped && this.isUsable() && this.vectors.counts().pending > 0) {
        this.scheduleBackfill(BACKFILL_PAUSE_MS)
      } else if (this.state === 'indexing') {
        this.publish('ready', 'Every indexed page is searchable by meaning.')
      }
    }
  }

  private async embedPage(page: PendingPage): Promise<void> {
    const chunks = chunkPage({
      title: page.title,
      siteName: page.siteName,
      excerpt: page.excerpt,
      body: page.body
    })

    if (chunks.length === 0) {
      // A page with no usable text at all still gets a bookkeeping row, or it
      // reappears as pending on every pass and the backfill never finishes.
      this.vectors.storePage(page.pageId, [], [], 'empty')
      return
    }

    const hash = hashChunks(chunks)
    if (this.vectors.contentHashFor(page.pageId) === hash) {
      // Re-visited, but the text did not change. Nothing to recompute.
      this.vectors.touch(page.pageId)
      return
    }

    const embedder = this.embedder
    if (!embedder) return
    const vectors = await embedder.embed(chunks)
    if (vectors.length !== chunks.length) {
      throw new Error('The embedding worker returned the wrong number of vectors')
    }
    this.vectors.storePage(page.pageId, chunks, vectors, hash)
  }

  private publish(state: SemanticState, detail: string): void {
    this.state = state
    this.detail = detail
    // Nothing is published during shutdown. `status()` reads counts from the
    // database, and the teardown that calls `stop()` closes that connection
    // without waiting for this promise chain to unwind — so a status broadcast
    // here throws on a closed handle, at a point where no window is left to
    // receive it anyway.
    if (this.stopped) return
    this.onStatusChanged(this.status())
  }
}

/**
 * Identity of a page's embeddable text.
 *
 * Over the chunks rather than the raw body, so a change that the chunker throws
 * away — a run of whitespace, a paragraph past the cap — correctly counts as no
 * change at all and costs nothing.
 */
function hashChunks(chunks: readonly string[]): string {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(chunk).update(' ')
  return hash.digest('hex').slice(0, 32)
}
