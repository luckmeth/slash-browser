import type { WebContents } from 'electron'
import { ExtractedPageSchema } from '@shared/types/memory'
import { originOf } from '@shared/url'
import { isInternalUrl } from '@shared/types/tab'
import type { MemoryRepository } from '../db/repositories/MemoryRepository'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'
import { buildExtractionScript } from './extractionScript'

const log = createLogger('memory')

/** Retention is checked on this cadence rather than on every page visit. */
const PRUNE_INTERVAL_MS = 30 * 60 * 1000

/**
 * Decides what may be indexed, and indexes it.
 *
 * The consent gate runs **before extraction**, not after. Extracting a page and
 * then discarding it would still have read the whole document into memory and
 * across a process boundary — for an excluded site that is exactly what the user
 * asked not to happen.
 *
 * Two independent settings, because they are different levels of exposure:
 *   - `indexHistory`     — URLs and titles become searchable
 *   - `indexPageContent` — the page's *text* is stored too
 * Both default to off.
 */
export class MemoryIndexer {
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly repository: MemoryRepository,
    private readonly settings: SettingsStore
  ) {}

  start(): void {
    if (this.pruneTimer) return
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS)
    this.prune()
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = null
  }

  /**
   * Whether this URL may be indexed at all, and how deeply.
   *
   * Returns the decision rather than a boolean so the caller can distinguish
   * "index metadata only" from "index the text too" without re-reading settings.
   */
  private decide(url: string, isPrivate: boolean): { index: boolean; content: boolean } {
    const settings = this.settings.getAll()
    const no = { index: false, content: false }

    if (!settings.indexHistory) return no
    // Private browsing is excluded by default and the setting says so.
    if (isPrivate && settings.excludePrivateFromMemory) return no
    if (isInternalUrl(url)) return no

    // Only http(s). A file:// path or a data: URL is not something to quietly
    // copy into a searchable store.
    if (!/^https?:\/\//i.test(url)) return no

    const origin = originOf(url)
    if (settings.excludedOrigins.some((excluded) => origin === excluded || url.startsWith(excluded)))
      return no

    return { index: true, content: settings.indexPageContent }
  }

  /**
   * Indexes a page that has finished loading.
   *
   * Failures are logged and swallowed: indexing is a background convenience and
   * must never disturb browsing.
   */
  async indexPage(contents: WebContents, url: string, isPrivate: boolean): Promise<void> {
    const decision = this.decide(url, isPrivate)
    if (!decision.index) return

    try {
      if (!decision.content) {
        // Metadata only — no extraction at all, so the document is never read.
        this.repository.upsert(
          {
            url,
            title: contents.getTitle(),
            siteName: null,
            excerpt: '',
            body: '',
            wordCount: 0
          },
          Date.now(),
          false
        )
        return
      }

      const raw: unknown = await contents.executeJavaScript(buildExtractionScript(), true)
      // The page produced this. Validate it exactly as carefully as anything
      // arriving from the network.
      const parsed = ExtractedPageSchema.safeParse(raw)
      if (!parsed.success) {
        log.warn(`extraction returned an unusable shape for ${originOf(url)}`)
        return
      }

      // Re-check against the *post-navigation* URL: a page can rewrite the
      // address bar with history.pushState between the gate and the extraction.
      if (!this.decide(parsed.data.url, isPrivate).content) return

      this.repository.upsert(parsed.data, Date.now(), true)
      log.debug(`indexed ${originOf(parsed.data.url)} (${parsed.data.wordCount} words)`)
    } catch (error) {
      log.warn(`could not index ${originOf(url)}`, error)
    }
  }

  prune(): void {
    const days = this.settings.getAll().memoryRetentionDays
    if (days <= 0) return
    this.repository.pruneOlderThan(Date.now() - days * 24 * 60 * 60 * 1000)
  }
}
