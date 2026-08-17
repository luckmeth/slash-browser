import { z } from 'zod'
import type { WebContents } from 'electron'
import type { PageInsight } from '@shared/types/pageInsight'
import { hostOf } from '@shared/url'
import { createLogger } from '../logger'
import {
  findCommercialSignals,
  findSourcingSignals,
  findUrgencySignals,
  rankLinkedHosts,
  readShoppingInsight,
  readingMinutes
} from './insightAnalysis'
import { buildInsightScript } from './insightScript'

const log = createLogger('insight')

/** Everything the injected collector may return. Page-authored, so validated. */
const CollectedSchema = z.object({
  url: z.string(),
  title: z.string().catch(''),
  siteName: z.string().nullable().catch(null),
  declaredSummary: z.string().nullable().catch(null),
  opening: z.string().catch(''),
  wordCount: z.number().int().min(0).catch(0),
  outline: z
    .array(z.object({ level: z.number().int().min(1).max(6), text: z.string() }))
    .max(60)
    .catch([]),
  links: z
    .array(z.object({ url: z.string(), host: z.string(), rel: z.string().catch('') }))
    .max(500)
    .catch([]),
  visibleText: z.string().catch(''),
  product: z.object({
    productName: z.string().nullable().catch(null),
    price: z.string().nullable().catch(null),
    availability: z.string().nullable().catch(null)
  }),
  looksLikeProduct: z.boolean().catch(false)
})

/**
 * Page Insight.
 *
 * Reads a page and reports what it declares about itself. Run on demand — the
 * collector walks up to 500 anchors and parses every JSON-LD block, which is
 * cheap once and wasteful on every page load.
 *
 * No AI, no network. The panel is explicit about that, because a user who
 * assumes a model read the page would over-trust findings that are really
 * pattern matches over markup.
 */
export class PageInsightService {
  async analyse(contents: WebContents | null): Promise<PageInsight> {
    if (!contents || contents.isDestroyed() || !/^https?:\/\//i.test(contents.getURL())) {
      return this.empty('', 'Page Insight works on web pages only.')
    }

    let raw: unknown
    try {
      raw = await contents.executeJavaScript(buildInsightScript(), true)
    } catch (error) {
      log.warn('insight collection threw', error)
      return this.empty(contents.getURL(), 'This page could not be read.')
    }

    const parsed = CollectedSchema.safeParse(raw)
    if (!parsed.success) {
      return this.empty(contents.getURL(), 'This page could not be read.')
    }

    const data = parsed.data
    const host = hostOf(data.url)
    const linkedHosts = rankLinkedHosts(data.links, host)
    const externalLinkCount = data.links.filter((link) => {
      const linkHost = link.host.toLowerCase().replace(/^www\./, '')
      return linkHost !== '' && linkHost !== host.toLowerCase().replace(/^www\./, '')
    }).length

    const signals = [
      ...findCommercialSignals(data.links, data.visibleText),
      ...findUrgencySignals(data.visibleText),
      ...findSourcingSignals(externalLinkCount, linkedHosts, data.wordCount)
    ]

    return {
      url: data.url,
      host,
      title: data.title,
      siteName: data.siteName,
      // The page's own description where it publishes one; its opening otherwise.
      // Stating which is which matters less than never inventing a summary.
      summary: data.declaredSummary ?? data.opening,
      wordCount: data.wordCount,
      readingMinutes: readingMinutes(data.wordCount),
      outline: data.outline,
      linkedHosts: linkedHosts.slice(0, 12),
      externalLinkCount,
      signals,
      shopping: data.looksLikeProduct
        ? readShoppingInsight({ ...data.product, visibleText: data.visibleText })
        : null,
      note: data.wordCount === 0 ? 'This page has no readable text.' : null
    }
  }

  private empty(url: string, note: string): PageInsight {
    return {
      url,
      host: hostOf(url),
      title: '',
      siteName: null,
      summary: '',
      wordCount: 0,
      readingMinutes: 1,
      outline: [],
      linkedHosts: [],
      externalLinkCount: 0,
      signals: [],
      shopping: null,
      note
    }
  }
}
