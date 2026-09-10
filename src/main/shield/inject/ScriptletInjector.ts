import type { WebContents } from 'electron'
import { createLogger } from '../../logger'
import { stripPlayerResponse, PLAYER_URL_PATTERNS } from './playerResponseFilter'

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
   * Ordering trace, for `SLASH_YT_TIMING_PROBE`.
   *
   * Every step of the install is a separate CDP round trip, and whether they
   * land before the page's own requests is the entire question behind "ads only
   * play on the first video". That is a race, and a race cannot be settled by
   * reading the code — so the steps announce themselves and the probe records
   * the order they actually happened in.
   */
  onTrace: ((event: string, detail?: string) => void) | null = null

  /**
   * Resolves once this tab's scripts are actually registered.
   *
   * The install is two CDP round trips, and they were fire-and-forget: the tab
   * was created, the install was *started*, and `loadURL` ran on the next line.
   * Measured on a real watch page, registration completed **535–1085 ms** after
   * the navigation began — because CDP replies queue behind the renderer, and
   * the renderer is at its busiest parsing the first heavy page of a cold
   * start. YouTube's player had already read `ytInitialPlayerResponse` by then,
   * so the advert played; every navigation afterwards found the script already
   * registered, which is why only the first video showed one.
   *
   * Awaiting this before the *first* load moves those round trips to a renderer
   * that has nothing else to do, where they take a few milliseconds.
   */
  private readonly installs = new Map<number, Promise<void>>()

  ready(contents: WebContents): Promise<void> {
    return this.installs.get(contents.id) ?? Promise.resolve()
  }

  /**
   * Whether a destination should have its scripts in place before it loads.
   *
   * **This used to be YouTube only**, on the reasoning that the strip was the
   * only time-critical script and that principle 1 forbids making every page
   * wait for a debugger. The first half was right; the second was an assumption
   * about cost that had never been measured.
   *
   * It has been now. `SLASH_SHIELD_WARMUP_PROBE` times a fresh view to a loaded
   * page both ways, interleaved, five runs each:
   *
   *     straight to the page   238ms, 66ms, 61ms, 65ms, 297ms   median 66ms
   *     blank document first    72ms, 72ms, 72ms, 75ms,  68ms   median 72ms
   *
   * **Six milliseconds on the median**, because the blank document buys a
   * renderer spawn the tab was going to pay for anyway — and the warmed arm is
   * markedly steadier, since the spawn stops competing with the page's own
   * parse. That is affordable, and what it buys is the other two scripts: the
   * pop-up defuser and the right-click restorer now register **before** a page's
   * own code runs rather than a few hundred milliseconds into it.
   *
   * Still not everything. `about:`, `file:` and internal pages get nothing,
   * because no script here would act on them and a blank document before a blank
   * document is pure waste.
   */
  needsEarlyInstall(url: string): boolean {
    if (this.scripts.every((script) => !script.enabled())) return false
    try {
      return /^https?:$/.test(new URL(url).protocol)
    } catch {
      return false
    }
  }

  private trace(event: string, detail?: string): void {
    this.onTrace?.(event, detail)
  }
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
    // Attached **here**, at tab creation, rather than only when a navigation
    // starts.
    //
    // This is the fix for adverts playing on the first YouTube video after a
    // cold start and on no video after it. Every step of the install —
    // `debugger.attach`, `Fetch.enable`, `Page.enable`,
    // `addScriptToEvaluateOnNewDocument` — is an asynchronous round trip, and
    // hanging all of them off `did-start-navigation` means they race the page
    // they are supposed to be protecting. YouTube's `/youtubei/v1/player` call
    // goes out very early, so on the *first* navigation of a fresh process —
    // the one that also pays for the first debugger attach — the player
    // response was frequently already on its way before `Fetch.enable` landed.
    // It was therefore never paused, never stripped, and its ad breaks played.
    //
    // On every navigation afterwards `attach` returns early because the tab is
    // already in `attached`, the filter is already enabled, and the adverts are
    // gone — which is exactly the shape of the report: first video only.
    //
    // Attaching at creation moves the whole handshake into tab setup, before a
    // URL has been asked for at all.
    //
    // `SLASH_YT_LAZY_ATTACH=1` restores the old, lazy behaviour. It exists so
    // the timing probe can be run against the bug as well as against the fix —
    // a probe that has only ever seen the fixed code has not been shown to be
    // capable of failing, which is the trap `SLASH_AUTOHIDE_PROBE` fell into.
    if (process.env['SLASH_YT_LAZY_ATTACH'] !== '1') {
      this.attach(contents)
    }

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
    contents.on('destroyed', () => {
      this.attached.delete(contents.id)
      this.installs.delete(contents.id)
    })
  }

  private attach(contents: WebContents): void {
    if (!this.allowed()) return
    if (contents.isDestroyed() || this.attached.has(contents.id)) return

    const active = this.scripts.filter((script) => script.enabled())
    if (active.length === 0) return

    this.trace('attach-start')
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

    // `Page.enable` **is required**, and removing it was a real bug.
    //
    // It was dropped in an earlier round on the reasoning that `enable` only
    // turns a domain's *events* on, that we use no Page events, and that it was
    // measurably expensive — 606 ms against a busy renderer versus 3 ms for
    // `Fetch.enable`. The reasoning was wrong: Chromium wires up document-start
    // script injection as part of enabling the domain, so
    // `addScriptToEvaluateOnNewDocument` **resolved successfully and the script
    // never ran**. Measured by `SLASH_YT_TIMING_PROBE`, which asks the page
    // whether the script's own stylesheet is present: `ran=false` on every
    // navigation of every run. The ad strip was not merely late, it was absent.
    //
    // Two lessons worth keeping. A command resolving is not the same as the
    // command having an effect, and the probe only caught it because it asks
    // the *page* rather than trusting the protocol's reply.
    //
    // It is affordable again because of the warm-up in `TabManager.buildView`:
    // the 606 ms was a renderer busy parsing YouTube, and this now runs against
    // an idle blank document instead.
    const install = contents.debugger
      .sendCommand('Page.enable')
      .then(() => {
        this.trace('page-enabled')
        return contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source,
          // Covers a navigation already in flight as well — a tab woken from
          // hibernation, or one whose load began before this landed.
          runImmediately: true
        })
      })
    this.installs.set(contents.id, install.then(() => undefined).catch(() => undefined))

    void install
      .then(() => {
        this.trace('script-installed', String(active.length))
        log.debug(`installed ${active.length} script(s)`)
      })
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
      this.trace('player-paused', String(paused.responseStatusCode ?? 'none'))
      log.debug(`paused a player response (status ${paused.responseStatusCode ?? 'none'})`)

      const letThrough = (): void => {
        void contents.debugger
          .sendCommand('Fetch.continueRequest', { requestId })
          .catch(() => undefined)
      }

      // Only responses carry a status; a paused *request* is continued at once.
      //
      // An attempt was made to hold the watch *document* here until the strip
      // was registered — using the fast browser-side Fetch domain to gate the
      // slow renderer-side Page one. It does not work: a page-target Fetch
      // domain never sees the main-frame document request, because that request
      // is issued by the browser for the frame rather than by the page. The
      // trace confirmed it, with no pause ever recorded. Recorded here so the
      // next person does not spend the same afternoon on it.
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

          this.trace('player-stripped', outcome.removed.join(','))
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
        // Every innertube endpoint that can carry ad breaks, not just
        // `player`. An advert played on a watch page reached by clicking a
        // related video: that is an in-page navigation, so no new HTML arrives
        // and the player data comes from innertube instead.
        patterns: PLAYER_URL_PATTERNS.map((urlPattern) => ({
          urlPattern,
          // Paused after the response arrives, which is the only stage where
          // there is a body to read.
          requestStage: 'Response' as const
        }))
      })
      .then(() => {
        this.trace('fetch-enabled')
        log.debug('player response filtering enabled')
      })
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
