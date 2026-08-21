import type { WebContents } from 'electron'
import { parse as parseHost } from 'tldts-experimental'
import { hostOf } from '@shared/url'
import { createLogger } from '../../logger'
import type { AdblockEngine } from './AdblockEngine'

const log = createLogger('adblock')

/**
 * Hides the boxes that blocked ads leave behind.
 *
 * Network blocking cancels the request, but the page's own layout still holds
 * the empty slot — a 300×250 gap, a "advertisement" caption, a collapsed
 * sidebar. Cosmetic filtering is what closes those, and it is most of the
 * visible difference between this and a DNS-level blocker.
 *
 * **It uses `webContents.insertCSS`, which is a first-class Electron API.** No
 * preload, no main-world script, no debugger. That matters: it is what lets
 * Slash have cosmetic filtering without widening `preload/content.ts`'s charter
 * or attaching a CDP client that would fight with DevTools.
 *
 * Applied at `dom-ready` rather than on navigation, because the stylesheet
 * belongs to a document that has to exist first. A blocked ad slot can
 * therefore be briefly visible on a slow page; the alternative is injecting
 * before the document commits, which needs the debugger and is not worth
 * spending the one CDP client on.
 *
 * Also applied on in-page navigation, because a single-page app changes route
 * without a new document and would otherwise keep the rules of whichever page
 * happened to load first. Re-inserting is cheap and idempotent — the rules for
 * a host are the same each time, and a duplicate stylesheet hides the same
 * elements.
 */
export class CosmeticFilter {
  constructor(
    private readonly adblock: AdblockEngine,
    private readonly enabled: () => boolean
  ) {}

  observe(contents: WebContents): void {
    contents.on('dom-ready', () => {
      if (!this.enabled() || !this.adblock.ready) return
      void this.apply(contents)
    })

    // In-page navigation too. A single-page app — YouTube, Reddit, Twitter —
    // changes route without loading a new document, so `dom-ready` fires once
    // and never again. Without this, cosmetic rules applied to the first page
    // you landed on and silently stopped working for every route after it,
    // which is precisely the wrong failure on the sites that need it most.
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isMainFrame) return
      if (!this.enabled() || !this.adblock.ready) return
      void this.apply(contents)
    })
  }

  private async apply(contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) return

    const url = contents.getURL()
    if (!/^https?:/i.test(url)) return

    const hostname = hostOf(url)
    if (hostname === '') return

    // The registrable domain, which is what a filter rule is written against
    // (`bbc.co.uk`, not `news.bbc.co.uk`). tldts carries the public-suffix list
    // and ships with the filter engine already, so this is the correct answer
    // rather than a two-label guess that is wrong for co.uk and github.io.
    const domain = parseHost(url).domain ?? hostname
    const styles = this.adblock.cosmeticStylesFor(url, hostname, domain)
    if (styles === '') return

    try {
      await contents.insertCSS(styles, { cssOrigin: 'user' })
    } catch (error) {
      // A page that navigated away mid-insert is the common case here and is
      // not worth a warning at anything above debug.
      log.debug('could not insert cosmetic styles', error)
    }
  }
}
