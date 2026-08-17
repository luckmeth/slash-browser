import type { WebContents } from 'electron'
import { createLogger } from '../logger'
import { buildYouTubeAdScript } from './youtubeAdScript'

const log = createLogger('shield')

/**
 * Removes YouTube's video ad breaks.
 *
 * Uses the Chrome DevTools Protocol's `Page.addScriptToEvaluateOnNewDocument`,
 * which is the only mechanism that runs code in a page's own JavaScript context
 * *before* the page's scripts do. Electron's preloads cannot: they run in an
 * isolated world by design, and that isolation is precisely what makes them safe
 * to inject everywhere.
 *
 * **This is a deliberate narrowing of the browser's security posture**, and it is
 * confined as tightly as the mechanism allows:
 *
 *  - the debugger is attached only to tabs that actually navigate to YouTube;
 *  - the script itself re-checks the hostname, so a tab that later goes
 *    elsewhere carries an inert script rather than an active one;
 *  - it is behind a setting the user can switch off.
 *
 * It also yields to DevTools. Only one client may attach to a webContents at a
 * time, so opening DevTools on a YouTube tab detaches this — the developer tools
 * working matters more than skipping an advert.
 */
export class YouTubeAdFilter {
  private readonly attached = new Set<number>()

  constructor(private readonly enabled: () => boolean) {}

  /** Watches a tab, attaching only if and when it visits YouTube. */
  observe(contents: WebContents): void {
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || !this.enabled()) return
      if (!/(^|\.)youtube(-nocookie)?\.com$/i.test(hostOf(details.url))) return
      this.attach(contents)
    })

    // Detached automatically when the view goes, but the id must not linger.
    contents.on('destroyed', () => this.attached.delete(contents.id))
  }

  private attach(contents: WebContents): void {
    if (this.attached.has(contents.id) || contents.isDestroyed()) return

    try {
      // Already attached means DevTools has it, in which case the browser's
      // developer tools win and ads play.
      if (contents.debugger.isAttached()) {
        log.debug('youtube filter: debugger already in use, leaving it alone')
        return
      }
      contents.debugger.attach('1.3')
    } catch (error) {
      log.warn('youtube filter: could not attach', error)
      return
    }

    this.attached.add(contents.id)

    contents.debugger.on('detach', () => {
      this.attached.delete(contents.id)
      log.debug('youtube filter: detached')
    })

    void contents.debugger
      .sendCommand('Page.enable')
      .then(() =>
        contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: buildYouTubeAdScript(),
          // The script must be in place for the very next document, including
          // the navigation currently in flight.
          runImmediately: true
        })
      )
      .then(() => log.info('youtube filter: ad-break removal installed for this tab'))
      .catch((error: unknown) => {
        log.warn('youtube filter: could not install the script', error)
        this.detach(contents)
      })
  }

  private detach(contents: WebContents): void {
    this.attached.delete(contents.id)
    try {
      if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
    } catch (error) {
      log.debug('youtube filter: detach threw', error)
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
