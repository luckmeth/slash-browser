import type { WebContents } from 'electron'
import { createLogger } from '../../logger'

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

  register(script: MainWorldScript): void {
    this.scripts.push(script)
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

  private detach(contents: WebContents): void {
    this.attached.delete(contents.id)
    try {
      if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
    } catch (error) {
      log.debug('detach threw', error)
    }
  }
}
