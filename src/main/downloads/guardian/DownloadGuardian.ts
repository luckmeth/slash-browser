import { z } from 'zod'
import type { WebContents } from 'electron'
import type { DownloadScan, MediaScan } from '@shared/types/downloadGuardian'
import { hostOf } from '@shared/url'
import { createLogger } from '../../logger'
import { analyseLink, rankCandidates, summarise } from './linkAnalysis'
import { buildScanScript } from './scanScript'

const log = createLogger('guardian')

/**
 * What the injected script is allowed to return.
 *
 * The page produced this, so it is validated as strictly as anything off the
 * network. A page that returns nonsense gets an empty scan, not an exception on
 * a code path the user did not ask for.
 */
const ScanResultSchema = z.object({
  pageUrl: z.string(),
  links: z
    .array(
      z.object({
        url: z.string(),
        label: z.string().catch(''),
        insideAdMarkup: z.boolean().catch(false)
      })
    )
    .max(400)
    .catch([]),
  media: z
    .array(
      z.object({
        url: z.string(),
        kind: z.enum(['video', 'audio']),
        container: z.string().nullable().catch(null),
        resolution: z.string().nullable().catch(null),
        sizeBytes: z.number().int().nullable().catch(null),
        label: z.string().catch('')
      })
    )
    .max(40)
    .catch([]),
  sawProtectedMedia: z.boolean().catch(false),
  mediaElementCount: z.number().int().catch(0)
})

/**
 * Smart Download Guardian and media detection.
 *
 * Scans on demand — never on every page load. The scan walks up to 400 anchors
 * and every media element, which is cheap once and pointless a hundred times for
 * pages the user never asks about.
 */
export class DownloadGuardian {
  constructor(private readonly isKnownAdHost: (host: string) => boolean) {}

  /** Classifies every download link on the page. */
  async scanDownloads(contents: WebContents | null): Promise<DownloadScan> {
    const raw = await this.scan(contents)
    if (!raw) {
      return {
        pageUrl: '',
        pageHost: '',
        candidates: [],
        note: 'This page could not be scanned.'
      }
    }

    const candidates = rankCandidates(
      raw.links
        .map((link) =>
          analyseLink(link, { pageUrl: raw.pageUrl, isKnownAdHost: this.isKnownAdHost })
        )
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    )

    return {
      pageUrl: raw.pageUrl,
      pageHost: hostOf(raw.pageUrl),
      candidates,
      note: summarise(candidates)
    }
  }

  /**
   * Finds media the page exposes as a plain downloadable file.
   *
   * The `note` is the important half. Most video on the web is streamed through
   * an adaptive manifest or assembled by script from a `blob:` source, and
   * neither can be downloaded without working around the platform's technical
   * protections — which this browser does not do. Saying so plainly is the
   * feature; an empty list would read as a bug.
   */
  async scanMedia(contents: WebContents | null): Promise<MediaScan> {
    const raw = await this.scan(contents)
    if (!raw) return { pageUrl: '', candidates: [], note: 'This page could not be scanned.' }

    if (raw.media.length > 0) {
      return { pageUrl: raw.pageUrl, candidates: raw.media, note: null }
    }

    if (raw.sawProtectedMedia) {
      return {
        pageUrl: raw.pageUrl,
        candidates: [],
        note:
          'Direct download is not available through the browser for this media. It is delivered as a ' +
          'stream rather than a file, and Slash does not work around a site’s technical protections.'
      }
    }
    if (raw.mediaElementCount > 0) {
      return {
        pageUrl: raw.pageUrl,
        candidates: [],
        note:
          'This page has media on it, but does not expose a direct file that Slash can download.'
      }
    }
    return { pageUrl: raw.pageUrl, candidates: [], note: 'No downloadable media found on this page.' }
  }

  private async scan(contents: WebContents | null): Promise<z.infer<typeof ScanResultSchema> | null> {
    if (!contents || contents.isDestroyed()) return null
    if (!/^https?:\/\//i.test(contents.getURL())) return null

    try {
      const raw: unknown = await contents.executeJavaScript(buildScanScript(), true)
      const parsed = ScanResultSchema.safeParse(raw)
      if (!parsed.success) {
        log.warn('page scan returned an unusable shape')
        return null
      }
      return parsed.data
    } catch (error) {
      log.warn('page scan threw', error)
      return null
    }
  }
}
