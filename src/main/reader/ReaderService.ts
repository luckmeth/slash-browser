import type { WebContents } from 'electron'
import {
  READER_MIN_WORDS,
  ReaderArticleSchema,
  type ReaderResult
} from '@shared/types/reader'
import { createLogger } from '../logger'
import { buildReaderScript } from './readerScript'

const log = createLogger('reader')

/**
 * Extracts an article from a live page for reader mode.
 *
 * Stateless and per-call: the article is derived on demand rather than cached,
 * because a cached copy of a page the user has since navigated away from is a
 * reader view showing the wrong article with no way to tell.
 */
export class ReaderService {
  async extract(contents: WebContents | null): Promise<ReaderResult> {
    if (!contents || contents.isDestroyed()) {
      return { article: null, reason: 'There is no page here to read.' }
    }

    const url = contents.getURL()
    if (!/^https?:\/\//i.test(url)) {
      return { article: null, reason: 'Reader mode works on web pages only.' }
    }

    let raw: unknown
    try {
      raw = await contents.executeJavaScript(buildReaderScript(), true)
    } catch (error) {
      log.warn('reader extraction threw', error)
      return { article: null, reason: 'This page could not be read.' }
    }

    if (raw === null || raw === undefined) {
      return { article: null, reason: notAnArticle }
    }

    // The page produced this. Validated exactly as carefully as anything off
    // the network, because that is what it is.
    const parsed = ReaderArticleSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn('reader extraction returned an unusable shape')
      return { article: null, reason: 'This page could not be read.' }
    }

    if (parsed.data.wordCount < READER_MIN_WORDS || parsed.data.blocks.length === 0) {
      // Showing a near-empty reader view reads as a broken feature rather than
      // as "this was never an article".
      return { article: null, reason: notAnArticle }
    }

    return { article: parsed.data, reason: null }
  }
}

const notAnArticle =
  'This does not look like an article — reader mode is for pages that are mostly text.'
