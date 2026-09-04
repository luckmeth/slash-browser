import type { net } from 'electron'
import type { DownloadCandidate } from '@shared/types/downloadGuardian'
import { analyseLink, rankCandidates } from './linkAnalysis'
import {
  clampOptions,
  CRAWL_LIMITS,
  extractLinks,
  isPageLike,
  matchesFilter,
  parseRobots,
  robotsAllows,
  ROBOTS_ALLOW_ALL,
  sameOrigin,
  shouldVisit,
  type CrawlOptions,
  type RobotsRules
} from './crawlPlan'
import type { MediaRequestContext } from '../engine/requestContext'
import { openMediaRequest } from '../engine/requestContext'
import { createLogger } from '../../logger'

const log = createLogger('grabber')

export interface SiteGrabResult {
  /** Every file found, ranked, with the guardian's verdict on each. */
  readonly candidates: DownloadCandidate[]
  readonly pagesVisited: number
  /** Pages the site's own `robots.txt` asked us not to fetch. */
  readonly skippedByRobots: number
  /** Why the crawl stopped, in plain language. */
  readonly note: string
}

/**
 * Follows a site's links and collects the files it publishes.
 *
 * The thing people install a download manager for when a site puts a hundred
 * PDFs across twenty pages. `DownloadGuardian` already reads the page you are
 * *on*; this walks outward from it.
 *
 * ## What makes it safe to put in a browser
 *
 * Pages are fetched with `net.request`, **never loaded in a renderer**. That is
 * the important decision: a crawler that opened each page in a real view would
 * run its scripts, fire its analytics, play its media and honour its redirects,
 * on twenty pages the user never chose to visit. Reading HTML and pulling the
 * anchors out is inert by comparison, and everything downstream — origin bound,
 * depth cap, page cap, `robots.txt` — lives in `crawlPlan.ts` where it is
 * tested.
 *
 * Requests carry the page's own context, for the same reason downloads do: a
 * members' area that needs a cookie is exactly where a site grab is useful, and
 * an anonymous fetch would silently collect twenty copies of a login page.
 *
 * ## What it deliberately does not do
 *
 * It does not run JavaScript, so a site that builds its file list in the client
 * yields nothing — and the note says so rather than reporting an empty result
 * as "no files here". It does not follow off-site links at all. And it stops
 * cleanly at every limit rather than degrading into a slow crawl nobody asked
 * to still be running.
 */
export class SiteGrabber {
  constructor(private readonly isKnownAdHost: (host: string) => boolean) {}

  private running = false

  /** Whether a grab is already under way. One at a time, deliberately. */
  get busy(): boolean {
    return this.running
  }

  async grab(
    seedUrl: string,
    requested: Partial<CrawlOptions>,
    context: MediaRequestContext | undefined
  ): Promise<SiteGrabResult> {
    const empty = (note: string): SiteGrabResult => ({
      candidates: [],
      pagesVisited: 0,
      skippedByRobots: 0,
      note
    })

    if (!/^https?:\/\//i.test(seedUrl)) {
      return empty('A site grab only works on an ordinary web page.')
    }
    if (this.running) return empty('A site grab is already running.')

    this.running = true
    try {
      return await this.walk(seedUrl, clampOptions(requested), context)
    } finally {
      this.running = false
    }
  }

  private async walk(
    seedUrl: string,
    options: CrawlOptions,
    context: MediaRequestContext | undefined
  ): Promise<SiteGrabResult> {
    const origin = new URL(seedUrl).origin
    const robots = options.respectRobots ? await this.readRobots(origin, context) : ROBOTS_ALLOW_ALL

    const seen = new Set<string>([seedUrl])
    const queue: { url: string; depth: number }[] = [{ url: seedUrl, depth: 0 }]
    const files = new Map<string, DownloadCandidate>()

    let pagesVisited = 0
    let skippedByRobots = 0
    let stoppedBy = ''

    while (queue.length > 0) {
      if (pagesVisited >= options.maxPages) {
        stoppedBy = `Stopped at ${options.maxPages} pages.`
        break
      }
      if (files.size >= CRAWL_LIMITS.maxFiles) {
        stoppedBy = `Stopped at ${CRAWL_LIMITS.maxFiles} files.`
        break
      }

      const step = queue.shift()
      if (!step) break

      // The seed is fetched whatever robots says: the user is looking at it, so
      // it has already been served to them. Everything discovered *from* it is
      // a request they did not make by hand, and that is where the rule binds.
      if (step.depth > 0 && options.respectRobots && !robotsAllows(step.url, robots)) {
        skippedByRobots += 1
        continue
      }

      const html = await this.fetchPage(step.url, context)
      pagesVisited += 1
      if (html === null) continue

      for (const link of extractLinks(html, step.url)) {
        if (!sameOrigin(link.url, seedUrl)) continue

        if (isPageLike(link.url)) {
          if (shouldVisit(link.url, seedUrl, step.depth + 1, seen, options, robots)) {
            seen.add(link.url)
            queue.push({ url: link.url, depth: step.depth + 1 })
          }
          continue
        }

        // A file. Classified by the guardian so a flagged one stays flagged and
        // "Download all" keeps excluding it — the same rule as a single-page
        // scan, and it matters more here: a grab of two hundred links is
        // precisely where nobody reads the list.
        if (!matchesFilter(link.url, options.extensions)) continue
        if (files.has(link.url)) continue

        const candidate = analyseLink(
          {
            url: link.url,
            label: link.label,
            // Ad markup is structural and only the page's own DOM can report
            // it. Fetched HTML has no layout, so this is honestly false rather
            // than guessed — `isKnownAdHost` still catches the host itself.
            insideAdMarkup: false
          },
          { pageUrl: step.url, isKnownAdHost: this.isKnownAdHost }
        )
        if (candidate) files.set(link.url, candidate)
      }
    }

    const candidates = rankCandidates([...files.values()])
    log.info(
      `site grab: ${pagesVisited} page(s), ${candidates.length} file(s)` +
        (skippedByRobots > 0 ? `, ${skippedByRobots} skipped by robots.txt` : '')
    )

    return {
      candidates,
      pagesVisited,
      skippedByRobots,
      note: this.describe(candidates.length, pagesVisited, skippedByRobots, stoppedBy, options)
    }
  }

  /**
   * What happened, in a sentence somebody can act on.
   *
   * An empty result has several very different causes and they need different
   * sentences — "this site builds its list with JavaScript" and "this site asked
   * us not to look" are not the same finding, and neither is "there is nothing
   * here".
   */
  private describe(
    fileCount: number,
    pagesVisited: number,
    skippedByRobots: number,
    stoppedBy: string,
    options: CrawlOptions
  ): string {
    const parts: string[] = []

    if (fileCount === 0) {
      parts.push(
        pagesVisited <= 1
          ? 'No files found on this page. Slash reads the links in the page’s HTML and does not run its scripts, so a site that builds its file list in the browser will look empty here.'
          : `No files found across ${pagesVisited} pages.`
      )
      if (options.extensions.length > 0) {
        parts.push(`Only ${options.extensions.join(', ')} were being collected.`)
      }
    } else {
      parts.push(
        `${fileCount} file${fileCount === 1 ? '' : 's'} found across ${pagesVisited} page${pagesVisited === 1 ? '' : 's'}.`
      )
    }

    if (skippedByRobots > 0) {
      parts.push(
        `${skippedByRobots} page${skippedByRobots === 1 ? '' : 's'} skipped because this site’s robots.txt asked crawlers not to fetch them.`
      )
    }
    if (stoppedBy !== '') parts.push(stoppedBy)
    return parts.join(' ')
  }

  /** The site's crawl rules, or permission to proceed when it has none. */
  private async readRobots(
    origin: string,
    context: MediaRequestContext | undefined
  ): Promise<RobotsRules> {
    const text = await this.fetchPage(`${origin}/robots.txt`, context)
    // A missing robots.txt means no restrictions — everywhere, not just here.
    return text === null ? ROBOTS_ALLOW_ALL : parseRobots(text)
  }

  /**
   * One page, as text, or null.
   *
   * Bounded by `maxPageBytes` because the response is whatever the server feels
   * like sending, and a crawler that buffers an endless body has handed a site
   * the ability to end the process.
   */
  private async fetchPage(
    url: string,
    context: MediaRequestContext | undefined
  ): Promise<string | null> {
    let request: ReturnType<typeof net.request>
    try {
      request = openMediaRequest(url, context, { Accept: 'text/html,*/*' })
    } catch {
      return null
    }

    try {
      const response = await new Promise<Electron.IncomingMessage>((resolve, reject) => {
        request.on('response', resolve)
        request.on('error', reject)
        setTimeout(() => reject(new Error('timeout')), 15_000)
        request.end()
      })

      // Redirects are not followed here on purpose. A redirect chain during a
      // crawl is a way to be walked somewhere else — the destination is simply
      // discovered again as a link if it is genuinely part of this site.
      if (response.statusCode >= 300) return null

      const type = String(response.headers['content-type'] ?? '')
      // Only markup. A 40 MB video fetched because it lacked an extension is
      // exactly the accident this avoids.
      if (type !== '' && !/text\/html|application\/xhtml|text\/plain/i.test(type)) return null

      return await new Promise<string>((resolve) => {
        const parts: Buffer[] = []
        let held = 0
        response.on('data', (chunk: Buffer) => {
          held += chunk.length
          if (held > CRAWL_LIMITS.maxPageBytes) {
            resolve(Buffer.concat(parts).toString('utf8'))
            return
          }
          parts.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
        response.on('error', () => resolve(''))
      })
    } catch {
      return null
    }
  }
}
