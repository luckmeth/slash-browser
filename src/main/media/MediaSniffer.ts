import type { Session, WebContents } from 'electron'
import { classifyMedia, MediaLedger, toDownloadable, type SniffedMedia } from './mediaSniffing'
import { createLogger } from '../logger'

const log = createLogger('media')

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
   * Fires on the change, not on every matching response: a video is thousands
   * of requests, and a callback per request would be a broadcast storm behind a
   * button that only needs to appear once.
   */
  onFound: ((webContentsId: number, count: number) => void) | null = null

  private readonly lastCount = new Map<number, number>()

  /**
   * Watches one session.
   *
   * Installed for every partition through `SessionRegistry`, because a workspace
   * with its own session is still a place somebody watches video.
   */
  install(session: Session, label: string): void {
    session.webRequest.onResponseStarted((details) => {
      const id = details.webContentsId
      if (typeof id !== 'number') return

      const headers = details.responseHeaders ?? {}
      const declared = Number(headerValue(headers, 'content-length'))
      const size = Number.isFinite(declared) && declared > 0 ? declared : null

      const found = classifyMedia(details.url, headerValue(headers, 'content-type'), size)
      if (!found) return
      this.ledger.record(id, found)

      const count = toDownloadable(this.ledger.forTab(id)).length
      if (count === (this.lastCount.get(id) ?? 0)) return
      this.lastCount.set(id, count)
      this.onFound?.(id, count)
    })

    log.debug(`media detection watching ${label}`)
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
      // The count is about to be recomputed against a new document, so the old
      // one must not suppress the callback that makes the button reappear.
      this.lastCount.delete(contents.id)
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
}

function headerValue(headers: Record<string, string[] | string>, name: string): string {
  // Servers send header names in whatever case they like.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? (value[0] ?? '') : String(value)
  }
  return ''
}
