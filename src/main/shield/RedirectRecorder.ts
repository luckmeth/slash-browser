import { randomUUID } from 'node:crypto'
import type { Session, WebContents } from 'electron'
import {
  REDIRECT_CHAIN_LIMIT,
  type RedirectChain,
  type RedirectHop
} from '@shared/types/redirectChain'
import { hostOf } from '@shared/url'
import { createLogger } from '../logger'
import { classifyChain, kindForStatus } from './redirectChain'

const log = createLogger('redirect')

/**
 * Records main-frame redirect chains so Redirect X-Ray has something to show.
 *
 * Two sources, because neither alone is enough:
 *
 *  - `did-start-navigation` / `did-redirect-navigation` on the tab give the
 *    ordered hops of the *main frame*, which is what the user actually
 *    experienced. Subresource redirects are irrelevant here and would bury it.
 *  - `webRequest.onBeforeRedirect` on the session carries the **status code**,
 *    which the navigation events do not expose. Without it every hop would be
 *    reported as "unknown" and the panel could not distinguish a permanent
 *    redirect from a temporary one.
 *
 * The two are correlated by URL. When correlation fails the hop is honestly
 * labelled `unknown` rather than guessed at.
 */
export class RedirectRecorder {
  private readonly chains: RedirectChain[] = []
  /** Status codes seen for a URL, consumed when the matching hop is recorded. */
  private readonly statusByUrl = new Map<string, number>()
  /** The chain currently being built for each tab. */
  private readonly open = new Map<string, RedirectChain>()

  constructor(
    private readonly isKnownAdHost: (host: string) => boolean,
    private readonly onChainCompleted: (chain: RedirectChain) => void
  ) {}

  /**
   * Watches a session for redirect status codes.
   *
   * Separate hook from the content blocker's `onBeforeRequest`, so the two do not
   * contend for a single-handler slot.
   */
  attachToSession(session: Session, label: string): void {
    session.webRequest.onBeforeRedirect((details) => {
      if (details.resourceType !== 'mainFrame') return
      // Keyed by destination: the hop about to be recorded is the redirect target.
      this.statusByUrl.set(details.redirectURL, details.statusCode)
      // Bounded, because a busy session would otherwise grow this forever.
      if (this.statusByUrl.size > 500) {
        const oldest = this.statusByUrl.keys().next().value
        if (oldest !== undefined) this.statusByUrl.delete(oldest)
      }
    })
    log.debug(`redirect recorder attached to ${label}`)
  }

  /** Wires a tab's navigation events. Called once per view. */
  attachToTab(tabId: string, contents: WebContents): void {
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      // A fresh navigation ends whatever chain was open and starts a new one.
      // `isSameDocument` navigations are in-page anchors, not redirects.
      if (details.isSameDocument) return
      this.begin(tabId, details.url)
    })

    contents.on('did-redirect-navigation', (details) => {
      if (!details.isMainFrame) return
      this.addHop(tabId, details.url)
    })

    contents.on('did-navigate', (_event, url) => {
      this.complete(tabId, url)
    })
  }

  /** Chains recorded for this window, newest first. */
  list(): RedirectChain[] {
    return [...this.chains].reverse()
  }

  /** The chain for a tab's most recent navigation, if there is one. */
  latestFor(tabId: string): RedirectChain | null {
    for (let index = this.chains.length - 1; index >= 0; index--) {
      const chain = this.chains[index]
      if (chain && chain.tabId === tabId) return chain
    }
    return null
  }

  clear(): void {
    this.chains.length = 0
    this.open.clear()
  }

  forget(tabId: string): void {
    this.open.delete(tabId)
  }

  private begin(tabId: string, url: string): void {
    this.open.set(tabId, {
      id: randomUUID(),
      tabId,
      originalUrl: url,
      finalUrl: url,
      hops: [this.hopFor(url)],
      verdict: 'ordinary',
      reasons: [],
      domains: [],
      startedAt: Date.now(),
      completedAt: null
    })
  }

  private addHop(tabId: string, url: string): void {
    const chain = this.open.get(tabId)
    // A redirect with no recorded start — possible if the recorder attached
    // mid-navigation. Starting a chain from here is better than dropping it.
    if (!chain) {
      this.begin(tabId, url)
      return
    }
    // Guard against a redirect loop filling memory.
    if (chain.hops.length >= 30) return
    chain.hops.push(this.hopFor(url))
    chain.finalUrl = url
  }

  private complete(tabId: string, url: string): void {
    const chain = this.open.get(tabId)
    this.open.delete(tabId)
    if (!chain) return

    // The landing page is the last hop when a redirect brought us here.
    if (chain.finalUrl !== url) {
      chain.hops.push(this.hopFor(url))
      chain.finalUrl = url
    }

    const classified = classifyChain(chain.hops, this.isKnownAdHost)
    chain.verdict = classified.verdict
    chain.reasons = classified.reasons
    chain.domains = classified.domains
    chain.completedAt = Date.now()

    // Direct navigations are the overwhelming majority and carry no information.
    // Keeping them would push everything interesting off the end of the list.
    if (chain.hops.length <= 1) return

    this.chains.push(chain)
    if (this.chains.length > REDIRECT_CHAIN_LIMIT) this.chains.shift()
    this.onChainCompleted(chain)
  }

  private hopFor(url: string): RedirectHop {
    const statusCode = this.statusByUrl.get(url) ?? null
    this.statusByUrl.delete(url)
    return {
      url,
      host: hostOf(url),
      // Client-side redirects arrive as navigations with no HTTP status of their
      // own; reporting them as `unknown` is accurate rather than assuming a code.
      kind: kindForStatus(statusCode),
      statusCode,
      at: Date.now()
    }
  }
}
