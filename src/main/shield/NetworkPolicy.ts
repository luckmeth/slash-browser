import type { Session } from 'electron'
import { hostOf } from '@shared/url'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'
import { AdblockEngine } from './adblock/AdblockEngine'
import { FilterEngine } from './FilterEngine'
import { ActivityLog } from './ActivityLog'
import {
  DEFAULT_BLOCK_DOMAINS,
  DEFAULT_MALICIOUS_DOMAINS,
  DEFAULT_TRACKER_DOMAINS,
  DEFAULT_PATH_RULES
} from './defaultLists'

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
  readonly engine = new FilterEngine()
  /**
   * Full filter-list blocking, alongside the domain engine above.
   *
   * Not a replacement: `engine` still owns the malicious list, per-site
   * exemptions and the host+path rules that reach first-party ad endpoints.
   * This one brings EasyList syntax, request types and cosmetic rules.
   */
  readonly adblock = new AdblockEngine()
  /** Per-tab record of what was blocked, and the source of the dashboard counts. */
  readonly activity: ActivityLog

  constructor(
    private readonly settings: SettingsStore,
    private hooks: ContentBlockerHooks,
    activity = new ActivityLog()
  ) {
    this.activity = activity
    this.engine.loadBlocked(DEFAULT_BLOCK_DOMAINS, 'ad')
    this.engine.loadBlocked(DEFAULT_TRACKER_DOMAINS, 'tracker')
    this.engine.loadPathRules(DEFAULT_PATH_RULES)
    this.engine.loadMalicious(DEFAULT_MALICIOUS_DOMAINS)
    this.engine.setAllowedSites(this.settings.getAll().blockingAllowedSites)
    this.engine.setCustomRules(this.settings.getAll().customBlockRules)
  }

  setHooks(hooks: ContentBlockerHooks): void {
    this.hooks = hooks
  }

  /** Re-reads the per-site exemptions and user rules after a settings change. */
  refreshAllowedSites(): void {
    const settings = this.settings.getAll()
    this.engine.setAllowedSites(settings.blockingAllowedSites)
    this.engine.setCustomRules(settings.customBlockRules)
  }

  countFor(webContentsId: number): number {
    return this.activity.totalFor(webContentsId)
  }

  resetCount(webContentsId: number): void {
    if (this.activity.reset(webContentsId)) this.hooks.onCountsChanged()
  }

  /**
   * Lightweight counters, for diagnosing why blocking is or is not firing.
   *
   * Numeric only. An earlier version also collected the set of third-party hosts
   * seen, which was useful once but would grow for the entire life of the
   * process in ordinary use.
   */
  readonly diagnostics = { seen: 0, withContentsId: 0, thirdParty: 0, resolvedPage: 0 }

  /** Dev-only tap on every decision. Null in normal use; see SLASH_YOUTUBE_PROBE. */
  onDecision: ((url: string, blocked: boolean) => void) | null = null

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

      // Host+path rules run BEFORE the first-party test, which is exactly why
      // they exist: YouTube serves its ad endpoints from youtube.com itself, so
      // the rule that stops domain blocking breaking the site you are on would
      // otherwise exempt them. Verified against a live watch page.
      const byPath = this.engine.classifyUrl(details.url)
      if (byPath) {
        const owner =
          details.webContentsId !== undefined
            ? this.hooks.resolvePageUrl(details.webContentsId)
            : null
        // A per-site exemption still wins: turning the shield off for a site has
        // to turn all of it off, not most of it.
        if (!owner || !this.engine.isSiteAllowed(hostOf(owner))) {
          this.onDecision?.(details.url, true)
          if (details.webContentsId !== undefined) {
            this.activity.record(details.webContentsId, byPath, requestHost, hostOf(owner ?? ''))
            this.hooks.onCountsChanged()
          }
          callback({ cancel: true })
          return
        }
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

      // The filter-list engine gets the first say, because it can express
      // things the domain lists structurally cannot: request types, first-party
      // exceptions, and the tens of thousands of rules in EasyList. It is only
      // consulted once the per-site exemption above has already passed, so
      // turning the shield off for a site still turns all of it off.
      //
      // It reports a match, not a reason. The domain lists are asked for the
      // label so the panel keeps saying "ad" or "tracker" rather than inventing
      // a third word; an unrecognised host counts as an ad, which is what the
      // large majority of list rules are for.
      if (this.adblock.matches(details.url, pageUrl, details.resourceType)) {
        this.onDecision?.(details.url, true)
        if (details.webContentsId !== undefined) {
          this.activity.record(
            details.webContentsId,
            this.engine.categoryOf(requestHost) ?? 'ad',
            requestHost,
            pageHost
          )
          this.hooks.onCountsChanged()
        }
        callback({ cancel: true })
        return
      }

      // One decision, recorded as it is made. The dashboard's ad and tracker
      // numbers are these entries counted — not a parallel tally that could
      // disagree with what actually happened.
      const category = this.engine.classifyRequest(requestHost, pageHost)
      this.onDecision?.(details.url, category !== null)
      if (category) {
        if (details.webContentsId !== undefined) {
          this.activity.record(details.webContentsId, category, requestHost, pageHost)
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
