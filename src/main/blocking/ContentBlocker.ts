import type { Session } from 'electron'
import { hostOf } from '@shared/url'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'
import { BlocklistEngine } from './BlocklistEngine'
import { DEFAULT_BLOCK_DOMAINS, DEFAULT_MALICIOUS_DOMAINS } from './defaultLists'

const log = createLogger('blocker')

export interface BlockedNavigation {
  url: string
  host: string
}

export interface ContentBlockerHooks {
  /** A top-level navigation was refused as malicious. */
  onMaliciousNavigation: (webContentsId: number, blocked: BlockedNavigation) => void
  /** Per-tab counter changed, so the shield can update. */
  onCountsChanged: () => void
  /**
   * The URL of the page that issued a request.
   *
   * Required, not optional. `details.referrer` is empty for most sub-resource
   * requests, and falling back to the request's own URL made every request look
   * first-party — which silently disabled blocking entirely. The page's identity
   * has to come from the WebContents that made the request.
   */
  resolvePageUrl: (webContentsId: number) => string | null
}

/**
 * Request-level blocking, installed on every session.
 *
 * Works by cancelling requests before they leave the machine — which means the
 * request genuinely is not made, rather than being loaded and hidden. That is
 * the difference between blocking and cosmetic filtering, and it is why this
 * also saves bandwidth and time rather than only tidying the page.
 */
export class ContentBlocker {
  readonly engine = new BlocklistEngine()
  /** Per-WebContents block counts, reset on navigation. */
  private readonly counts = new Map<number, number>()

  constructor(
    private readonly settings: SettingsStore,
    private hooks: ContentBlockerHooks
  ) {
    this.engine.loadBlocked(DEFAULT_BLOCK_DOMAINS)
    this.engine.loadMalicious(DEFAULT_MALICIOUS_DOMAINS)
    this.engine.setAllowedSites(this.settings.getAll().blockingAllowedSites)
  }

  setHooks(hooks: ContentBlockerHooks): void {
    this.hooks = hooks
  }

  /** Re-reads the per-site exemptions after a settings change. */
  refreshAllowedSites(): void {
    this.engine.setAllowedSites(this.settings.getAll().blockingAllowedSites)
  }

  countFor(webContentsId: number): number {
    return this.counts.get(webContentsId) ?? 0
  }

  resetCount(webContentsId: number): void {
    if (this.counts.delete(webContentsId)) this.hooks.onCountsChanged()
  }

  /**
   * Lightweight counters, for diagnosing why blocking is or is not firing.
   *
   * Numeric only. An earlier version also collected the set of third-party hosts
   * seen, which was useful once but would grow for the entire life of the
   * process in ordinary use.
   */
  readonly diagnostics = { seen: 0, withContentsId: 0, thirdParty: 0, resolvedPage: 0 }

  /**
   * Installs the filter on a session.
   *
   * Applied through `SessionRegistry` like every other session concern, so an
   * isolated workspace gets the same filtering as the default one rather than
   * silently browsing unfiltered.
   */
  apply(target: Session, label: string): void {
    target.webRequest.onBeforeRequest((details, callback) => {
      this.diagnostics.seen += 1
      if (details.webContentsId !== undefined) this.diagnostics.withContentsId += 1
      const settings = this.settings.getAll()

      // Never interfere with our own chrome or internal pages.
      if (!/^https?:/i.test(details.url)) {
        callback({ cancel: false })
        return
      }

      const requestHost = hostOf(details.url)

      // 1. Malicious top-level navigation → refuse and let the UI explain.
      if (settings.blockMaliciousSites && this.engine.isMalicious(requestHost)) {
        if (details.resourceType === 'mainFrame') {
          log.warn(`refused navigation to known-malicious ${requestHost}`)
          if (details.webContentsId !== undefined) {
            this.hooks.onMaliciousNavigation(details.webContentsId, {
              url: details.url,
              host: requestHost
            })
          }
        }
        callback({ cancel: true })
        return
      }

      // 2. Ads and trackers. Sub-resources only — a top-level navigation the
      //    user typed is theirs to make, even to an ad network.
      if (!settings.blockAds || details.resourceType === 'mainFrame') {
        callback({ cancel: false })
        return
      }

      // The page's own host, not the request's, decides first-party status.
      const pageUrl =
        details.webContentsId !== undefined
          ? this.hooks.resolvePageUrl(details.webContentsId)
          : null
      // Without a page identity we cannot tell first- from third-party, and
      // guessing wrong would break pages. Let it through.
      if (!pageUrl) {
        callback({ cancel: false })
        return
      }

      this.diagnostics.resolvedPage += 1
      const pageHost = hostOf(pageUrl)
      if (hostOf(details.url) !== pageHost) this.diagnostics.thirdParty += 1
      if (this.engine.isSiteAllowed(pageHost)) {
        callback({ cancel: false })
        return
      }

      if (this.engine.shouldBlockRequest(requestHost, pageHost)) {
        if (details.webContentsId !== undefined) {
          this.counts.set(details.webContentsId, (this.counts.get(details.webContentsId) ?? 0) + 1)
          this.hooks.onCountsChanged()
        }
        callback({ cancel: true })
        return
      }

      callback({ cancel: false })
    })

    log.debug(`content blocker installed on ${label}`)
  }
}
