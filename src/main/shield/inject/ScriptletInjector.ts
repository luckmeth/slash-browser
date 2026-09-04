import type { WebContents } from 'electron'
import { createLogger } from '../../logger'
import { stripPlayerResponse, PLAYER_URL_PATTERN } from './playerResponseFilter'

const log = createLogger('inject')

/**
 * One script that runs in a page's own JavaScript context.
 *
 * Every script must gate itself at runtime — checking its own hostname, its own
 * setting — because a script installed with
 * `Page.addScriptToEvaluateOnNewDocument` persists for the life of the
 * WebContents and will therefore run on whatever that tab visits next.
 */
export interface MainWorldScript {
  readonly id: string
  /** Whether the feature is switched on at all. Checked before installing. */
  readonly enabled: () => boolean
  /** Source, wrapped in its own IIFE and responsible for its own gating. */
  readonly source: () => string
}

/**
 * The single owner of main-world script injection.
 *
 * **Why this exists at all:** only one debugger client may attach to a given
 * `WebContents`. Slash needs two scripts in the page — the YouTube ad-break
 * strip and the `window.open` defuser — and if each attached its own client the
 * second would silently fail. So there is exactly one attach point, and scripts
 * register with it.
 *
 * This is the deliberate widening of a capability that CLAUDE.md previously
 * recorded as YouTube-only, and it is kept as narrow as the mechanism allows:
 *
 *  - scripts run only on `http(s)` documents;
 *  - each one re-checks its own hostname and setting at runtime;
 *  - nothing here opens a channel back to anything privileged — these scripts
 *    can change the page they are in and nothing else;
 *  - **DevTools always wins.** Opening it detaches us; closing it reattaches.
 *    Working developer tools matter more than skipping an advert, and a browser
 *    whose DevTools mysteriously refuse to open is a worse browser.
 */
export class ScriptletInjector {
  private readonly scripts: MainWorldScript[] = []
  private readonly attached = new Set<number>()
  /**
   * Whether YouTube player responses should be filtered on the wire.
   *
   * Injected rather than read from here so this class keeps knowing nothing
   * about settings; `AppContext` supplies the same switch the page script uses.
   */
  private filterPlayerResponses: () => boolean = () => false

  /**
   * @param allowed The user's switch for page scripts as a whole. Checked on
   *   every attach, so turning it off stops new tabs immediately; `releaseAll`
   *   hands back the debugger clients already held.
   */
  constructor(private readonly allowed: () => boolean = () => true) {}

  register(script: MainWorldScript): void {
    this.scripts.push(script)
  }

  /**
   * Turns on response filtering for YouTube's player endpoint.
   *
   * Separate from `register` because it is not a script: it happens over the
   * same debugger connection but one layer below the page, which is the whole
   * point — see `playerResponseFilter.ts` for why a page-world patch is not
   * enough on its own.
   */
  filterYouTubePlayer(enabled: () => boolean): void {
    this.filterPlayerResponses = enabled
  }

  observe(contents: WebContents): void {
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      if (!/^https?:/i.test(details.url)) return
      this.attach(contents)
    })

    // DevTools is the one client we always yield to. Detaching on open is what
    // makes the developer tools usable at all; reattaching on close is what
    // stops that being a permanent loss of protection for the tab.
    contents.on('devtools-opened', () => this.detach(contents))
    contents.on('devtools-closed', () => this.attach(contents))
    contents.on('destroyed', () => this.attached.delete(contents.id))
  }

  private attach(contents: WebContents): void {
    if (!this.allowed()) return
    if (contents.isDestroyed() || this.attached.has(contents.id)) return

    const active = this.scripts.filter((script) => script.enabled())
    if (active.length === 0) return

    try {
      if (contents.debugger.isAttached()) {
        log.debug('debugger already in use; leaving it alone')
        return
      }
      contents.debugger.attach('1.3')
    } catch (error) {
      log.warn('could not attach', error)
      return
    }

    this.attached.add(contents.id)
    contents.debugger.on('detach', () => this.attached.delete(contents.id))
    this.interceptPlayerResponses(contents)

    // Each script is its own IIFE and its own try/catch, so one throwing cannot
    // stop the next from installing — and neither can break the page.
    const source = active
      .map((script) => `try{${script.source()}}catch(e){}`)
      .join('\n')

    void contents.debugger
      .sendCommand('Page.enable')
      .then(() =>
        contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source,
          // Must cover the navigation already in flight, not just the next one.
          runImmediately: true
        })
      )
      .then(() => log.debug(`installed ${active.length} script(s)`))
      .catch((error: unknown) => {
        log.warn('could not install scripts', error)
        this.detach(contents)
      })
  }

  /**
   * Strips ad breaks out of YouTube player responses as they arrive.
   *
   * The page script cannot do this on its own: YouTube restores `JSON.parse`
   * and `Response.prototype.json` after we patch them — measured, not assumed —
   * so every response after the first arrived unfiltered. A response paused
   * here belongs to the browser, and the page has no way to reach it.
   *
   * Everything about the handler is written to fail open. A paused request that
   * is never continued hangs the page for ever, which is a far worse outcome
   * than an advert, so every path ends in either `fulfillRequest` or
   * `continueRequest` and any throw falls through to continuing.
   */
  private interceptPlayerResponses(contents: WebContents): void {
    if (!this.filterPlayerResponses()) return

    contents.debugger.on('message', (_event, method, params) => {
      if (method !== 'Fetch.requestPaused') return

      const paused = params as {
        requestId: string
        responseStatusCode?: number
        responseHeaders?: { name: string; value: string }[]
      }
      const requestId = paused.requestId
      log.debug(`paused a player response (status ${paused.responseStatusCode ?? 'none'})`)

      const letThrough = (): void => {
        void contents.debugger
          .sendCommand('Fetch.continueRequest', { requestId })
          .catch(() => undefined)
      }

      // Only responses carry a status; a paused *request* is continued at once.
      if (paused.responseStatusCode === undefined) {
        letThrough()
        return
      }

      void contents.debugger
        .sendCommand('Fetch.getResponseBody', { requestId })
        .then((result) => {
          const { body, base64Encoded } = result as { body: string; base64Encoded: boolean }
          const outcome = stripPlayerResponse(body, base64Encoded)
          if (outcome.body === null) {
            letThrough()
            return
          }

          log.debug(`stripped ${outcome.removed.join(', ')} from a player response`)
          return contents.debugger.sendCommand('Fetch.fulfillRequest', {
            requestId,
            responseCode: paused.responseStatusCode ?? 200,
            responseHeaders: paused.responseHeaders ?? [],
            body: outcome.body
          })
        })
        .catch(() => letThrough())
    })

    void contents.debugger
      .sendCommand('Fetch.enable', {
        // No `resourceType`. YouTube's innertube calls go through `fetch()`,
        // which the protocol reports as `Fetch` rather than `XHR` — filtering
        // on XHR matched nothing at all, which looked exactly like the feature
        // working. The URL pattern is specific enough on its own.
        patterns: [
          {
            urlPattern: PLAYER_URL_PATTERN,
            // Paused after the response arrives, which is the only stage where
            // there is a body to read.
            requestStage: 'Response'
          }
        ]
      })
      .then(() => log.debug('player response filtering enabled'))
      .catch((error: unknown) => log.warn('could not enable response filtering', error))
  }

  /**
   * Re-registers scripts after a setting changed.
   *
   * The set of scripts is chosen **once per attachment**, so turning a feature
   * on after a tab was already attached left it uninstalled indefinitely: the
   * attach path returns early for a tab it already holds, and nothing else
   * reconsiders. Found by a probe whose own control run turned the YouTube
   * strip off and then on again, and measured `accessorInstalled: false` on the
   * second run — the browser was reporting a feature as on while nothing was
   * installed.
   *
   * Detaching and re-attaching re-runs that choice. The new set applies to the
   * next document in each tab rather than the current one, because
   * `addScriptToEvaluateOnNewDocument` is exactly that — so a page open at the
   * moment of the change keeps its old behaviour until it is reloaded, which is
   * honest and is what the settings copy should say.
   */
  refresh(all: readonly WebContents[]): void {
    for (const contents of all) {
      this.detach(contents)
      this.attach(contents)
    }
  }

  /**
   * Releases every debugger client, for when the user switches page scripts off.
   *
   * Without this, turning the setting off would stop *new* tabs being touched
   * while every tab already open kept its client — so the switch would appear
   * not to work on the pages the user was actually looking at.
   */
  releaseAll(all: readonly WebContents[]): void {
    for (const contents of all) this.detach(contents)
  }

  private detach(contents: WebContents): void {
    this.attached.delete(contents.id)
    try {
      if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
    } catch (error) {
      log.debug('detach threw', error)
    }
  }
}
