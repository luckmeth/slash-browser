import type { Session, WebContents } from 'electron'
import { classifyMedia, MediaLedger, toDownloadable, type SniffedMedia } from './mediaSniffing'
import { createLogger } from '../logger'

const log = createLogger('media')

/**
 * Resource types that can carry media, and no others.
 *
 * This is the whole performance story. A `webRequest` listener registered
 * without a filter is a main-process callback for **every response on every
 * page** — scripts, stylesheets, fonts, every image — and Slash already spends
 * one of those on `onBeforeRequest` for the content blocker. Doubling it made
 * ordinary browsing measurably heavier for a feature that only ever cares about
 * a handful of responses.
 *
 * `media` is a `<video>`/`<audio>` element's own fetches. `xhr` covers `fetch()`
 * and XMLHttpRequest, which is how Media Source Extensions pulls segments and
 * how most players request a manifest. `object` catches the legacy embed path.
 * Everything else is excluded before the callback exists, which is where the
 * cost actually is — by the time a listener runs, the headers have already been
 * marshalled across.
 */
const MEDIA_RESOURCE_TYPES = ['media', 'xhr', 'object'] as const

/**
 * Finds the video a page is playing, from the requests it makes.
 *
 * This is the half of media detection the DOM cannot provide. Every serious
 * video site loads through Media Source Extensions, where the `<video>`
 * element's `src` is a `blob:` URL that means nothing outside that page — so a
 * scan that reads the document finds nothing on exactly the pages people ask
 * about. What the network fetched is the only view that sees the real file.
 *
 * **Hooked on `onResponseStarted`, deliberately.** `onBeforeRequest` already
 * belongs to `ContentBlocker`, and Electron allows exactly one listener per
 * event per session — registering a second would silently replace Slash
 * Shield's blocking with this. Responses are also the better event: the
 * `Content-Type` and `Content-Length` that make classification possible do not
 * exist until the server has answered.
 *
 * **It does not circumvent DRM and must not be made to.** Encrypted streams are
 * recognised in order to be excluded and explained, never decrypted. Netflix
 * will not work here, exactly as it does not work in any download manager, and
 * saying so plainly is better than a download that produces an unplayable file.
 */
export class MediaSniffer {
  private readonly ledger = new MediaLedger()

  /**
   * A tab now has something downloadable that it did not have a moment ago.
   *
   * Fires on the change, not on every matching response: a playing video
   * re-requests the same URL several times a second, and a callback per
   * request would be a broadcast storm behind a button already on screen.
   */
  onFound: ((webContentsId: number, count: number) => void) | null = null

  private readonly lastCount = new Map<number, number>()
  /** Every session being watched, so the setting can be applied to all of them. */
  private readonly watched = new Map<string, Session>()
  private enabled = true

  constructor(enabled = true) {
    this.enabled = enabled
  }

  /**
   * Watches one session.
   *
   * Installed for every partition through `SessionRegistry`, because a workspace
   * with its own session is still a place somebody watches video.
   */
  install(session: Session, label: string): void {
    this.watched.set(label, session)
    this.apply(session)
    log.debug(`media detection ${this.enabled ? 'watching' : 'idle on'} ${label}`)
  }

  /**
   * Turns detection off, and genuinely off.
   *
   * The listener is *removed* rather than left in place behind a boolean. A
   * registered listener costs a main-process callback per response whether or
   * not it does anything, so a switch that only skipped the body would leave
   * the cost the user turned it off to avoid.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    for (const session of this.watched.values()) this.apply(session)
    if (enabled) return

    // Switched off means forgotten, not paused. Leaving a list of what somebody
    // watched before turning detection off is the opposite of what they asked
    // for, and it would reappear the moment they turned it back on.
    for (const id of this.lastCount.keys()) this.ledger.forget(id)
    this.lastCount.clear()
  }

  private apply(session: Session): void {
    if (!this.enabled) {
      session.webRequest.onResponseStarted(null)
      return
    }

    session.webRequest.onResponseStarted(
      { urls: ['<all_urls>'], types: [...MEDIA_RESOURCE_TYPES] },
      (details) => {
        const id = details.webContentsId
        if (typeof id !== 'number') return

        const headers = details.responseHeaders ?? {}
        const declared = Number(headerValue(headers, 'content-length'))
        const size = Number.isFinite(declared) && declared > 0 ? declared : null

        // The frame that actually made the request. On a film site the player
        // is a cross-origin iframe, and its origin — not the tab's — is what
        // the CDN checks its referrer against.
        const frameUrl = details.frame?.url ?? details.referrer ?? ''
        const found = classifyMedia(
          details.url,
          headerValue(headers, 'content-type'),
          size,
          frameUrl
        )
        if (!found) {
          // Temporary diagnostic: why is nothing from YouTube ever offered?
          if (process.env['SLASH_SNIFF_DEBUG'] && /googlevideo|videoplayback/i.test(details.url)) {
            log.info(
              `sniff-reject type=${details.resourceType} ct=${headerValue(headers, 'content-type')} ` +
                `len=${size} url=${details.url.slice(0, 110)}`
            )
          }
          return
        }

        // Already seen this URL on this document — the common case while a video
        // plays, and not news.
        if (!this.ledger.record(id, found)) return
        // Only a complete file can change the count behind the button.
        if (found.kind !== 'file') return

        const count = toDownloadable(this.ledger.forTab(id)).length
        if (count === (this.lastCount.get(id) ?? 0)) return
        this.lastCount.set(id, count)
        this.onFound?.(id, count)
      }
    )
  }

  /**
   * Follows one tab's navigations.
   *
   * Both kinds. A new document obviously ends the old page's media, but so does
   * clicking the next video on YouTube, which is a same-document route change —
   * and that is the case people actually hit. `MediaLedger` handles the race
   * between the route change and the new video's first request.
   */
  observe(contents: WebContents): void {
    const advance = (): void => {
      this.ledger.advance(contents.id)
      // Recomputed against the new document. Kept in `lastCount` rather than
      // merely cleared, because that map is also the cheap answer to "does this
      // tab have anything" — and that question is asked on every tab snapshot.
      const count = this.countFor(contents)
      this.lastCount.set(contents.id, count)
      this.onFound?.(contents.id, count)
    }
    contents.on('did-start-navigation', (details) => {
      // Subframe navigations are constant on video sites and mean nothing here.
      if (details.isMainFrame) advance()
    })
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) advance()
    })
    contents.once('destroyed', () => {
      this.ledger.forget(contents.id)
      this.lastCount.delete(contents.id)
    })
  }

  /** What this tab is playing, best first. */
  forTab(contents: WebContents | null): SniffedMedia[] {
    if (!contents || contents.isDestroyed()) return []
    return this.ledger.forTab(contents.id)
  }

  /** How many complete files this tab has, for the toolbar indicator. */
  countFor(contents: WebContents | null): number {
    return toDownloadable(this.forTab(contents)).length
  }

  /**
   * The memoised count, without ranking anything.
   *
   * Exists because "should the chip be up" is asked on **every tab snapshot**,
   * which is often. Answering it by re-ranking sixty entries each time would be
   * a small cost paid constantly — the shape of slowness that never shows up in
   * a profile as one expensive thing.
   */
  knownCount(contents: WebContents | null): number {
    if (!contents || contents.isDestroyed()) return 0
    return this.lastCount.get(contents.id) ?? 0
  }
}

function headerValue(headers: Record<string, string[] | string>, name: string): string {
  // Servers send header names in whatever case they like.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? (value[0] ?? '') : String(value)
  }
  return ''
}
