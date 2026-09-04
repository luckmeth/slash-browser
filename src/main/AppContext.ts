import {
  playerQualities,
  READ_QUALITIES_SCRIPT,
  requestQualityScript
} from './media/playerQuality'
/**
 * How long to let the player run after a quality change before looking.
 *
 * Its buffer is already full at the old quality, so it requests nothing
 * until that drains. Measured against a live watch page: reading back
 * immediately finds nothing every time.
 */
const QUALITY_SETTLE_MS = 6000
import { YtDlpService } from './downloads/external/YtDlpService'
import { isExpiringMediaHost } from './media/mediaSniffing'
import { exec } from 'node:child_process'
import { Notification } from 'electron'
import { COMPLETION_GRACE_MS, type CompletionAction } from './downloads/engine/completionAction'
import { SponsorNoticeService } from './sponsor/SponsorNoticeService'
import type { ProfileRegistry } from './profiles/ProfileRegistry'
import type { AddressFieldKind } from '@shared/addressFields'
import { basename, dirname, join } from 'node:path'
import { app, powerMonitor, type BaseWindow, type WebContents } from 'electron'
import { Database } from './db/Database'
import { HistoryRepository } from './db/repositories/HistoryRepository'
import { BookmarkRepository } from './db/repositories/BookmarkRepository'
import { DownloadRepository } from './db/repositories/DownloadRepository'
import { EngineDownloadRepository } from './db/repositories/EngineDownloadRepository'
import { WorkspaceRepository } from './db/repositories/WorkspaceRepository'
import { SettingsStore } from './settings/SettingsStore'
import { SessionHardening } from './sessions/SessionHardening'
import { SessionRegistry } from './sessions/SessionRegistry'
import { DownloadManager } from './downloads/DownloadManager'
import { SiteGrabber } from './downloads/guardian/SiteGrabber'
import { ClipboardWatcher } from './downloads/ClipboardWatcher'
import type { MediaRequestContext } from './downloads/engine/requestContext'
import type { MediaCandidate } from '@shared/types/downloadGuardian'
import { mediaIdentity } from './media/mediaIdentity'
import { readStreamVariants, type StreamQuality } from './downloads/engine/StreamDownload'
import { IpcRegistry } from './ipc/registry'
import { installContentSignalListener } from './tabs/contentSignals'
import type { EventChannel, EventPayload } from '@shared/ipc/contracts'
import { hostOf } from '@shared/url'
import { PermissionRepository } from './db/repositories/PermissionRepository'
import { PermissionManager } from './permissions/PermissionManager'
import { SnapshotRepository } from './db/repositories/SnapshotRepository'
import { TabGroupRepository } from './db/repositories/TabGroupRepository'
import { ReadingListRepository } from './db/repositories/ReadingListRepository'
import { ExtensionManager } from './extensions/ExtensionManager'
import { SponsorService } from './sponsor/SponsorService'
import { PasswordVault } from './passwords/PasswordVault'
import { LoginFiller } from './passwords/LoginFiller'
import { ClosedTabRepository } from './db/repositories/ClosedTabRepository'
import { SessionSnapshotManager } from './snapshots/SessionSnapshotManager'
import { MemoryRepository } from './db/repositories/MemoryRepository'
import { VectorStore } from './db/repositories/VectorStore'
import { MemoryIndexer } from './memory/MemoryIndexer'
import { SemanticIndex } from './memory/embedding/SemanticIndex'
import { MemorySearchService } from './memory/MemorySearchService'
import { ChromiumImporter } from './import/ChromiumImporter'
import { MediaKeyService } from './media/MediaKeyService'
import { AddressBook } from './addresses/AddressBook'
import { RemoteConfigService } from './config/RemoteConfigService'
import { AddressFiller } from './addresses/AddressFiller'
import { PrintService } from './printing/PrintService'
import { SyncService } from './sync/SyncService'
import { TranslationService } from './translate/TranslationService'
import { ReaderService } from './reader/ReaderService'
import { CleanupService } from './cleanup/CleanupService'
import { PageInsightService } from './insight/PageInsightService'
import { DownloadQueue } from './downloads/engine/DownloadQueue'
import { DownloadGuardian } from './downloads/guardian/DownloadGuardian'
import { MediaSniffer } from './media/MediaSniffer'
import { formatSize, suggestedFilename, toDownloadable } from './media/mediaSniffing'
import { PageMediaExtractor } from './media/PageMediaExtractor'
import { buildContextMenuScript } from './shield/inject/contextMenuScript'
import {
  extensionFor,
  sniffNoteFor,
  SEPARATE_STREAMS_NOTE,
  type MediaChoice
} from './media/pageFormats'
import { DefaultBrowserService } from './system/DefaultBrowserService'
import { AiEngine } from './ai/AiEngine'
import { ProviderRegistry } from './ai/ProviderRegistry'
import { AiComparisonService } from './ai/AiComparison'
import { ContentBlocker } from './shield/NetworkPolicy'
import { PopupGuard } from './shield/PopupGuard'
import { RedirectGuard } from './shield/RedirectGuard'
import { GestureTracker } from './shield/GestureTracker'
import { ScriptletInjector } from './shield/inject/ScriptletInjector'
import { CosmeticFilter } from './shield/adblock/CosmeticFilter'
import { buildYouTubeAdScript } from './shield/youtubeAdScript'
import { buildPopupDefuserScript } from './shield/inject/popupDefuserScript'
import { registerHandlers } from './ipc/handlers'
import { REWARDS_URL } from '@shared/types/tab'
import { AdvertiserService } from './advertising/AdvertiserService'
import { RewardsService } from './rewards/RewardsService'
import { codeFromRedirect } from './rewards/callbackCheck'
import { ActivityTracker } from './rewards/ActivityTracker'
import { BrowserWindowController } from './windows/BrowserWindowController'
import type { MediaOffer } from './windows/BrowserWindowController'
import { CrashReporting } from './diagnostics/CrashReporting'
import { UpdateService } from './updates/UpdateService'
import { shouldPromptForUpdate } from './updates/launchPrompt'
import { PageWatchService } from './snapshots/PageWatchService'
import { MissionService } from './missions/MissionService'
import { createLogger } from './logger'
import { describeMachine, effectiveMode } from '@shared/hardwareProfile'
import { readMachine } from './performance/readMachine'

const log = createLogger('app')

/**
 * Where the bundled embedding model lives.
 *
 * Shipped via electron-builder `extraResources`, which places it *beside*
 * app.asar rather than inside it. That is deliberate: the ONNX runtime opens
 * these files natively, and a native file open cannot see through an asar
 * archive — the same trap that broke sqlite-vec's extension path.
 */
function bundledModelsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models')
    : join(app.getAppPath(), 'resources', 'models')
}

/**
 * Composition root.
 *
 * Everything is constructed here in dependency order and torn down in the exact
 * reverse. Startup order matters: the database must be open before settings can
 * load, and settings must be loaded before any window reads them. Shutdown order
 * matters just as much — the SQLite connection is checkpointed and closed last,
 * after every writer is gone.
 */
/**
 * One row in the download picker.
 *
 * `MediaChoice` plus what the UI needs to render it, plus — for a quality
 * chosen out of a master playlist — the numbers that playlist declared. The
 * hint travels with the choice rather than being looked up again at download
 * time, because by then we would be reading a *variant* playlist, which does
 * not restate its own bitrate.
 */
export type MediaOption = MediaChoice & {
  sizeText: string
  streamHint?: { bandwidth?: number; quality?: string | null }
  /**
   * This is a playlist, and the engine must be told so.
   *
   * Carried rather than inferred from the address: HLS is routinely served from
   * a path with no extension, and the difference between "playlist" and "file"
   * is the difference between a video and four kilobytes of text saved as one.
   */
  isStream?: boolean
}

/**
 * How long a master playlist's variant list is worth reusing.
 *
 * Long enough to cover the picker asking twice for one download, short enough
 * that a signed playlist is fetched again rather than replayed after it expired.
 */
const VARIANT_CACHE_MS = 60_000

/** `1920x1080` → `1080p`, which is what the quality is actually called. */
function qualityLabel(variant: { resolution: string | null; bandwidth: number }): string {
  const height = Number(variant.resolution?.split(/x/i)[1] ?? Number.NaN)
  if (Number.isFinite(height) && height > 0) return `${height}p`
  if (variant.resolution) return variant.resolution
  return variant.bandwidth > 0 ? `${Math.round(variant.bandwidth / 1000)} kbps` : 'Stream'
}

/**
 * The honest figure for a stream: its bitrate, not a guess at its size.
 *
 * The total is knowable only after the variant playlist is read, and reading
 * every variant's playlist to fill in a picker is thousands of segments' worth
 * of parsing for a number the user is about to make one choice from.
 */
/** Drops the two-halves sentence, keeping whatever else the note said. */
function withoutSeparateStreamsNote(note: string | null): string | null {
  if (note === null) return null
  const rest = note.replace(SEPARATE_STREAMS_NOTE, '').trim()
  return rest === '' ? null : rest
}

function bitrateText(bandwidth: number): string {
  if (bandwidth <= 0) return 'size known once it starts'
  const mbps = bandwidth / 1_000_000
  return `${mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${Math.round(bandwidth / 1000)} kbps`} · size known once it starts`
}

/**
 * How long after launch the Slash Coin invitation appears.
 *
 * Long enough that the browser has clearly finished starting and the user has
 * settled into whatever they opened it for.
 */
const REWARDS_INVITE_DELAY_MS = 90_000

export class AppContext {
  readonly db: Database
  readonly settings: SettingsStore
  readonly ipc: IpcRegistry
  readonly history: HistoryRepository
  readonly bookmarks: BookmarkRepository
  readonly workspaces: WorkspaceRepository
  readonly permissionRepository: PermissionRepository
  readonly permissions: PermissionManager
  readonly snapshotRepository: SnapshotRepository
  readonly closedTabs: ClosedTabRepository
  readonly tabGroups: TabGroupRepository
  readonly readingList: ReadingListRepository
  readonly extensions: ExtensionManager
  readonly sponsor: SponsorService
  readonly vault: PasswordVault
  readonly loginFiller: LoginFiller
  /**
   * Whether each live page has a sign-in form, keyed by webContents id.
   *
   * Not persisted and not per-tab-id: it describes the *document* currently
   * loaded, and a navigation replaces it. Booleans only — the preload reports
   * that fields exist, never what is in them.
   */
  readonly loginForms = new Map<number, { hasPasswordField: boolean; hasUsernameField: boolean }>()
  readonly snapshots: SessionSnapshotManager
  readonly memoryRepository: MemoryRepository
  readonly vectors: VectorStore
  readonly semantic: SemanticIndex
  readonly memorySearch: MemorySearchService
  readonly memory: MemoryIndexer
  readonly importer: ChromiumImporter
  readonly reader = new ReaderService()
  readonly printing = new PrintService()
  readonly sync: SyncService
  readonly rewards: RewardsService
  readonly advertiser: AdvertiserService
  readonly activity: ActivityTracker
  /** Tracks the edge, so the config fetch happens on the transition only. */
  private rewardsWasEnabled = false
  readonly translation: TranslationService
  readonly addresses: AddressBook
  readonly remoteConfig: RemoteConfigService
  readonly sponsorNotices: SponsorNoticeService
  readonly addressFiller = new AddressFiller()
  /** Set at launch from the base user-data path — see `applyProfile`. */
  profiles: ProfileRegistry | null = null
  activeProfileId = 'default'
  /** Which address fields each live document offers, by WebContents id. */
  readonly addressForms = new Map<number, readonly string[]>()
  private syncTimer: NodeJS.Timeout | null = null
  /**
   * Hardware media keys. Registered only while Slash has focus by default —
   * `globalShortcut` is genuinely global, and holding these permanently would
   * silently steal pause from whatever else the user is listening to.
   */
  readonly mediaKeys: MediaKeyService
  readonly cleanup = new CleanupService()
  readonly insight = new PageInsightService()
  readonly downloadEngine: DownloadQueue
  private readonly ytDlp: YtDlpService
  /** Where engine downloads are written down, so they survive a quit. */
  readonly engineDownloadRepository: EngineDownloadRepository
  readonly guardian: DownloadGuardian
  /** Follows a site's links and collects the files it publishes. */
  readonly siteGrabber: SiteGrabber
  /** Notices a copied download link, when the user has asked it to. */
  readonly clipboard: ClipboardWatcher
  readonly mediaSniffer: MediaSniffer
  readonly pageMedia = new PageMediaExtractor()
  readonly defaultBrowser: DefaultBrowserService
  readonly crashes: CrashReporting
  readonly updates: UpdateService
  readonly watch: PageWatchService
  readonly missions: MissionService
  /**
   * Off-mission suggestion per tab, if any.
   *
   * Not persisted and scoped to the tab: a prompt about a page the user has since
   * navigated away from is noise, and one that survived a restart would be
   * baffling.
   */
  readonly missionSuggestions = new Map<string, string>()
  readonly ai: AiEngine
  /** The AI Hub's provider catalogue and credential store. */
  readonly providers: ProviderRegistry
  readonly comparison = new AiComparisonService()
  readonly blocker: ContentBlocker
  readonly popups: PopupGuard
  readonly redirects: RedirectGuard
  /**
   * Scripts that run in a page's own JavaScript context.
   *
   * Owns the one debugger client per tab, shared by the YouTube ad-break strip
   * and the `window.open` defuser, and yields it to DevTools on demand.
   */
  readonly injector: ScriptletInjector
  /** The script switches as they were, so a change can be noticed. */
  private lastScriptSwitches = ''
  /**
   * Whether this launch has already asked about an update.
   *
   * Deliberately in memory and never persisted: "cancel" means until the
   * browser is next opened, which is what makes the prompt unmissable without
   * making it a thing that follows you around.
   */
  private updatePrompted = false
  /** Hides the empty slots that blocked ads leave behind. */
  readonly cosmetics: CosmeticFilter
  private readonly gestures = new GestureTracker()
  /**
   * Tabs with "Stay on This Site" turned on.
   *
   * Deliberately not persisted. It is a mode you switch on for the page you are
   * looking at right now — a lock silently still in force days later, on a tab
   * restored from a snapshot, would look like the browser was broken.
   */
  readonly siteLockedTabs = new Set<string>()
  /** Undo closure from the most recent approved AI plan, if it is reversible. */
  lastAiUndo: (() => void) | null = null
  readonly downloads: DownloadManager
  readonly sessions: SessionRegistry
  private readonly hardening = new SessionHardening()
  private readonly downloadRepository: DownloadRepository
  private readonly windows: BrowserWindowController[] = []
  /** Sessions hardened so far, replayed to each new window's recorder. */
  private readonly observedSessions: { session: Electron.Session; label: string }[] = []
  private disposeContentSignals: (() => void) | null = null
  private started = false

  constructor() {
    this.db = new Database(app.getPath('userData'))
    this.settings = new SettingsStore(this.db)
    this.defaultBrowser = new DefaultBrowserService(this.settings)
    // Constructed with the stored value rather than switched off afterwards:
    // installing the listener and removing it a moment later would still have
    // registered it for the first page load.
    this.mediaSniffer = new MediaSniffer(this.settings.getAll().detectPageMedia)
    this.ipc = new IpcRegistry()
    this.history = new HistoryRepository(this.db)
    this.bookmarks = new BookmarkRepository(this.db)
    this.workspaces = new WorkspaceRepository(this.db)
    this.permissionRepository = new PermissionRepository(this.db)
    // Hooks are replaced in start() once windows can exist; until then a prompt
    // has nowhere to render and the manager denies rather than hangs.
    this.permissions = new PermissionManager(this.permissionRepository, {
      showPrompt: () => false,
      dismissPrompt: () => {},
      onGrantsChanged: () => {}
    })
    this.memoryRepository = new MemoryRepository(this.db)
    // Constructed even when semantic search is off. It stays inert until
    // `enable()` succeeds, and the repository needs the handle regardless so
    // that forgetting a page can take its vectors with it.
    this.vectors = new VectorStore(this.db)
    this.memoryRepository.attachVectorStore(this.vectors)
    this.semantic = new SemanticIndex(
      this.vectors,
      this.settings,
      bundledModelsDir(),
      (status) => this.broadcastAll('memory:semanticChanged', status)
    )
    this.memorySearch = new MemorySearchService(this.memoryRepository, this.semantic)
    this.memory = new MemoryIndexer(this.memoryRepository, this.settings, this.semantic)
    this.importer = new ChromiumImporter(this.bookmarks, this.history)
    // The engine runs alongside Electron's own download path rather than
    // replacing it: an ordinary click-to-download still goes through
    // DownloadManager, while explicitly managed transfers get segmenting,
    // queueing and retries.
    this.engineDownloadRepository = new EngineDownloadRepository(this.db)
    this.downloadEngine = new DownloadQueue(
      () => this.downloads.directory(),
      () => this.settings.getAll().downloadConnections,
      () => this.settings.getAll().downloadBandwidthLimit,
      (items) => this.broadcastAll('downloadEngine:changed', items),
      this.engineDownloadRepository,
      () => this.settings.getAll().downloadQueues,
      () => this.settings.getAll().sortDownloadsByCategory,
      (action) => void this.runCompletionAction(action),
      () => this.settings.getAll().downloadCompletionAction
    )
    this.ytDlp = new YtDlpService(() => this.settings.getAll().externalDownloaderPath)
    this.crashes = new CrashReporting(this.db)
    this.updates = new UpdateService(
      () => this.settings.getAll().updateFeedUrl,
      (status) => {
        this.broadcastAll('updates:changed', status)
        // The chip still appears; this is the half that cannot be scrolled
        // past. Guarded so a six-hourly re-check never reopens it -- see
        // launchPrompt.ts, where the whole decision lives and is tested.
        if (shouldPromptForUpdate({ state: status.state, promptedThisLaunch: this.updatePrompted })) {
          this.updatePrompted = true
          this.focusedWindow()?.showUpdateRequired()
        }
      }
    )
    // A feed address is set by default, so this does check on launch.
    this.updates.startAutoCheck(
      () => this.settings.getAll().updateAutoCheck,
      () => this.settings.getAll().updateAutoDownload
    )
    this.watch = new PageWatchService(this.db)
    this.missions = new MissionService(this.db)
    this.ai = new AiEngine(this.settings, this.db)
    this.providers = new ProviderRegistry(this.db, this.settings)
    // Hooks are replaced in start(); until then a blocked navigation has no UI
    // to report to, but the request is still refused.
    this.blocker = new ContentBlocker(this.settings, {
      onMaliciousNavigation: () => {},
      onCountsChanged: () => {},
      resolvePageUrl: (webContentsId) => this.pageUrlFor(webContentsId)
    })
    // Reuses Shield's existing host list rather than keeping a second copy that
    // could disagree with it about what counts as an ad network.
    this.guardian = new DownloadGuardian((host) => this.blocker.engine.isKnownAdHost(host))
    // The same host list, for the same reason: a file found three pages deep
    // must get the same verdict as one on the page you are looking at.
    this.siteGrabber = new SiteGrabber((host) => this.blocker.engine.isKnownAdHost(host))
    this.clipboard = new ClipboardWatcher(
      () => this.settings.getAll().watchClipboardForDownloads,
      (offer) => {
        // Offered on the focused window only. A copied link is one intention,
        // and three windows each showing the same strip is three chances to
        // click it twice.
        this.focusedWindow()?.showNotice(
          `Copied a link to ${offer.filename}`,
          'info',
          { label: 'Download', downloadUrl: offer.url }
        )
      }
    )
    // Both guards ask "was this the user?", so they share one gesture history —
    // two would be two answers that can disagree. Hooks are replaced in start()
    // once there is a window to report a block to.
    this.popups = new PopupGuard(
      { onPopupBlocked: () => {}, openInNewTab: () => {} },
      this.gestures
    )
    this.redirects = new RedirectGuard(
      { onNavigationBlocked: () => {}, onNavigationWarned: () => {} },
      this.gestures,
      (host) => this.blocker.engine.isKnownAdHost(host)
    )
    // One injector, not one per feature: only a single debugger client may
    // attach to a WebContents, so two scripts each attaching their own would
    // mean the second silently never ran.
    this.cosmetics = new CosmeticFilter(
      this.blocker.adblock,
      () => this.settings.getAll().blockAds
    )
    this.injector = new ScriptletInjector(() => this.settings.getAll().allowPageScripts)
    this.translation = new TranslationService(this.providers, this.settings)
    this.addresses = new AddressBook(this.db)
    this.remoteConfig = new RemoteConfigService(this.settings, (config) =>
      this.broadcastAll('config:changed', config)
    )
    this.sync = new SyncService(this.db, this.settings, () =>
      this.broadcastAll('sync:changed', this.sync.status())
    )

    this.rewards = new RewardsService(
      this.db,
      this.settings,
      () => this.broadcastRewards(),
      () => this.finishSignInUi()
    )
    // The same account as Slash Coin, because it is the same Google sign-in.
    this.advertiser = new AdvertiserService(this.rewards, this.settings)
    this.activity = new ActivityTracker(
      () => {
        // Genuine focus, not `focusedWindow()` - that falls back to the first
        // window so callers always get one, which here would mean a browser
        // sitting behind somebody's IDE earned all afternoon.
        const window = this.windows.find((w) => w.isFocused)
        return {
          focused: window !== undefined,
          url: window?.tabs.activeTab?.snapshot.url ?? '',
          privateWindow: window?.isPrivate === true,
          idleSeconds: powerMonitor.getSystemIdleTime()
        }
      },
      this.rewards,
      this.settings,
      () => this.broadcastRewards()
    )
    this.mediaKeys = new MediaKeyService(
      this.settings,
      () => this.allWindows(),
      () => this.focusedWindow() ?? null
    )
    // The wire-level half of the same feature. The page script wins the first
    // response cheaply; this one covers every response after it, which the
    // page can otherwise take back by restoring its own natives.
    this.injector.filterYouTubePlayer(
      () => this.settings.getAll().blockAds && this.settings.getAll().blockYouTubeVideoAds
    )
    this.injector.register({
      id: 'youtube-ads',
      enabled: () =>
        this.settings.getAll().blockAds && this.settings.getAll().blockYouTubeVideoAds,
      source: buildYouTubeAdScript
    })
    this.injector.register({
      id: 'context-menu',
      enabled: () => this.settings.getAll().restoreContextMenu,
      source: buildContextMenuScript
    })
    this.injector.register({
      id: 'popup-defuser',
      // Tied to popup blocking, because that is what creates the null this
      // repairs. With popups allowed through there is nothing to defuse.
      enabled: () => this.settings.getAll().blockPopups,
      source: buildPopupDefuserScript
    })
    this.snapshotRepository = new SnapshotRepository(this.db)
    this.closedTabs = new ClosedTabRepository(this.db)
    this.tabGroups = new TabGroupRepository(this.db)
    this.readingList = new ReadingListRepository(this.db)
    this.extensions = new ExtensionManager(this.settings)
    this.sponsor = new SponsorService(this.db, this.settings, () =>
      this.broadcastAll('sponsor:changed', {})
    )
    this.sponsorNotices = new SponsorNoticeService(this.settings, this.sponsor, () =>
      this.focusedWindow() ?? null
    )
    this.vault = new PasswordVault(this.db)
    this.loginFiller = new LoginFiller(this.vault)
    this.snapshots = new SessionSnapshotManager(
      this.snapshotRepository,
      this.settings,
      () => this.windows
    )
    this.downloadRepository = new DownloadRepository(this.db)
    this.sessions = new SessionRegistry(this.hardening)
    // Registered before any session is acquired, so every partition — including
    // an isolated workspace's — gets the filter rather than browsing unfiltered.
    this.sessions.setContentBlocker(this.blocker)
    // Redirect status codes are only available from webRequest, and only for the
    // sessions actually in use — including isolated workspaces' partitions.
    // Sessions are hardened before the first window exists — the default one is
    // acquired during start() — so they are remembered here and every window's
    // recorder is attached to all of them at construction. Iterating windows
    // alone would silently miss the default session and record no status codes.
    // Media detection watches responses, which is the only view that sees a
    // video loaded through Media Source Extensions. Registered before any
    // session is acquired, for the same reason the blocker is.
    this.sessions.setMediaSniffer(this.mediaSniffer)
    // Only the window whose *active* tab found something is told. A video
    // playing in a background tab is not a reason to put a button in front of
    // somebody reading a different page.
    this.mediaSniffer.onFound = (webContentsId, count) => {
      for (const window of this.windows) {
        if (window.tabs.activeTab?.contents?.id !== webContentsId) continue
        this.ipc.broadcast('media:found', { count }, window.privilegedContents())
        // The toolbar button and the floating chip are two views of the same
        // fact, and both have to move together or one of them is lying.
        window.refreshMediaOffer()
      }
    }
    this.sessions.setRedirectObserver({
      attachToSession: (session, label) => {
        this.observedSessions.push({ session, label })
        for (const window of this.windows) window.redirectRecorder.attachToSession(session, label)
      }
    })
    this.downloads = new DownloadManager(this.downloadRepository, this.settings, {
      onChanged: (items) => this.broadcastAll('downloads:changed', items),
      // The engine has existed since Phase 6 and nothing outside our own UI ever
      // reached it. This is the wire that makes clicking a link on a page use
      // several connections instead of one.
      // The referrer travels with it. Chromium's own download would have sent
      // one, so taking the download over and dropping it turns a working link
      // into a 403 on every host that checks — which is most of the hosts
      // people accelerate downloads from.
      accelerate: (url, filename, initiator) => {
        // "Ask where to save" used to switch the accelerator off entirely: the
        // save dialog belonged to Chromium, so a preference about *where* a file
        // goes quietly decided *how* it downloaded. The engine asks instead.
        if (!this.settings.getAll().askWhereToSaveDownloads) {
          this.downloadEngine.enqueue(url, {
            priority: 'normal',
            startAfter: null,
            filename,
            context: this.mediaContextFor(initiator)
          })
          return
        }

        void this.askWhereToSave(filename).then((chosen) => {
          // Cancelled means cancelled. Starting the download anyway into the
          // default folder would be answering a question with the wrong answer.
          if (!chosen) {
            log.info(`download cancelled at the save dialog: ${filename}`)
            return
          }
          this.downloadEngine.enqueue(url, {
            priority: 'normal',
            startAfter: null,
            filename: chosen.filename,
            directory: chosen.directory,
            context: this.mediaContextFor(initiator)
          })
        })
      },
      getWindow: () => this.focusedWindow()?.browserWindow ?? null
    })
  }

  /** Called once at launch, before `start()`. */
  attachProfiles(registry: ProfileRegistry, activeId: string): void {
    this.profiles = registry
    this.activeProfileId = activeId
  }

  /**
   * Restarts into another profile.
   *
   * A relaunch, because `app.setPath('userData', …)` is only honoured before
   * anything has opened a file — by the time a user clicks "switch", the
   * database, the session partitions and every cache are already open on the
   * current profile. Chrome does the same thing for the same reason.
   *
   * One profile at a time: the single-instance lock covers the whole
   * application, so a second profile cannot run alongside the first. Stated in
   * the UI rather than discovered.
   */
  switchProfile(id: string): void {
    if (!this.profiles?.has(id) || id === this.activeProfileId) return
    // Everything else on the command line is dropped deliberately: relaunching
    // with --new-private-window, say, would reopen whatever the last launch
    // asked for rather than the profile the user just chose.
    app.relaunch({ args: [`--profile=${id}`] })
    app.quit()
  }

  start(): void {
    // After `app.whenReady()`, which is the whole point: `safeStorage` is not
    // usable before it, so reading this in a constructor signed the user out
    // of Slash Coin on every launch. The activity tracker reads `signedIn` on
    // each tick, so earning resumes from here without further wiring.
    this.rewards.restoreSession()
    this.broadcastRewards()

    if (this.started) return
    this.db.open()
    this.settings.load()

    // After settings load: it reads them to decide whether to register at all.
    this.mediaKeys.start()

    // Does nothing until sponsorship is on, a notice campaign is live, and the
    // cadence allows it -- which on a default install is never.
    this.sponsorNotices.start()

    // Inert unless a publisher configured an endpoint, so a default install
    // makes no request here at all.
    void this.remoteConfig.refresh()

    // Sync on a timer while the browser is open. Does nothing at all until the
    // user has enabled it, set an endpoint, and unlocked with a passphrase —
    // `SyncService.sync` returns immediately otherwise, so this costs an
    // interval check and no network on a default install.
    this.syncTimer = setInterval(
      () => void this.sync.sync(),
      Math.max(5, this.settings.getAll().syncIntervalMinutes) * 60_000
    )

    SessionHardening.normaliseUserAgent()
    // Acquiring the session through the registry is what applies the hardening;
    // the download handler must be attached to that same hardened session.
    this.downloads.restore()
    this.downloads.attachToSession(this.sessions.getDefault())

    // Engine downloads come back from the database. Anything that was
    // transferring when Slash closed returns **paused** — see `restore` — so
    // nothing starts spending bandwidth the moment the browser opens. The
    // session is resolved by partition name, which is why cookies still work
    // for a download picked up days later without any having been stored.
    this.downloadEngine.restore(this.engineDownloadRepository.loadAll(), (partition) =>
      this.sessions.fromPartition(partition)
    )

    // Web content's only outbound channel. Untrusted by construction — see
    // contentSignals.ts for why it is kept out of IpcRegistry.
    this.disposeContentSignals = installContentSignalListener(
      (webContentsId) => {
        for (const window of this.windows) {
          const match = window.tabs.allTabs().find((tab) => tab.contents?.id === webContentsId)
          if (match) return match
        }
        return null
      },
      {
        onUserGesture: (webContentsId) => this.popups.noteGesture(webContentsId),
        // Records what the *current document* offers. A navigation replaces the
        // entry, and a destroyed tab drops it, so the offer to fill can never
        // outlive the form it was about.
        onLoginForm: (webContentsId, form) => {
          if (form.hasPasswordField) this.loginForms.set(webContentsId, form)
          else this.loginForms.delete(webContentsId)
        },
        // Same lifetime rule: what the *current document* offers. A navigation
        // replaces the entry, so an offer to fill can never outlive its form.
        onAddressForm: (webContentsId, fields) => {
          if (fields.length > 0) this.addressForms.set(webContentsId, fields)
          else this.addressForms.delete(webContentsId)
        }
      }
    )

    // A blocked popup has to reach the user. Silently dropping one is
    // indistinguishable from a broken link, so the notice is not optional
    // decoration — it is the half of the feature that makes a wrong call
    // recoverable.
    this.popups.setHooks({
      onPopupBlocked: (webContentsId, popup, explanation) => {
        const window = this.windowForContents(webContentsId)
        if (!window) return
        this.ipc.broadcast(
          'shield:popupBlocked',
          { popup, explanation },
          window.privilegedContents()
        )
      },
      openInNewTab: (url, background) => {
        const window = this.focusedWindow()
        window?.tabs.create({ url, background })
      },
      isKnownAdHost: (host) => this.blocker.engine.isKnownAdHost(host)
    })

    // A refused navigation is recorded so the shield panel can account for it.
    // Warnings are recorded too and deliberately not blocked: the evidence is a
    // pattern rather than a rule, and the product rule is that we never call a
    // navigation malicious without one.
    this.redirects.setHooks({
      onNavigationBlocked: (webContentsId, host, explanation) => {
        const pageHost = hostOf(this.pageUrlFor(webContentsId) ?? '')
        this.blocker.activity.record(webContentsId, 'redirect', host, pageHost)
        const window = this.windowForContents(webContentsId)
        if (!window) return
        this.ipc.broadcast(
          'shield:navigationBlocked',
          { host, explanation },
          window.privilegedContents()
        )
      },
      onNavigationWarned: (webContentsId, host, explanation) => {
        const window = this.windowForContents(webContentsId)
        if (!window) return
        this.ipc.broadcast(
          'shield:navigationWarned',
          { host, explanation },
          window.privilegedContents()
        )
      }
    })

    // A refused malicious navigation had been reported to nobody since this
    // hook was written: the request was genuinely cancelled, but the user saw a
    // failed page load with no reason given, which is indistinguishable from
    // the site being down.
    this.blocker.setHooks({
      onMaliciousNavigation: (webContentsId, blocked) => {
        const window = this.windowForContents(webContentsId)
        if (!window) return
        this.ipc.broadcast(
          'shield:navigationBlocked',
          {
            host: blocked.host,
            explanation:
              'This site is on a list of known-malicious domains, so Slash refused to load it.'
          },
          window.privilegedContents()
        )
      },
      onCountsChanged: () => {},
      resolvePageUrl: (webContentsId) => this.pageUrlFor(webContentsId)
    })

    // Prompts render in the window that owns the requesting tab; grant changes
    // are announced to every window so two dashboards cannot disagree.
    this.permissions.setHooks({
      showPrompt: (request) => {
        const window = request.tabId ? this.windowForTab(request.tabId) : this.windows[0]
        if (!window) return false
        window.showPermissionPrompt(request)
        return true
      },
      dismissPrompt: (requestId) => {
        for (const window of this.windows) window.dismissPermissionPrompt(requestId)
      },
      onGrantsChanged: () => this.broadcastAll('permissions:changed', this.permissions.listGrants())
    })

    // Only now can a permission be answered by anything other than "no".
    this.hardening.setResolver({
      request: (partition, origin, kinds, tabId, tabTitle) =>
        this.permissions.request(partition, origin, kinds, tabId, tabTitle),
      check: (partition, origin, kind, tabId) =>
        this.permissions.check(partition, origin, kind, tabId),
      identifyTab: (webContentsId) => {
        for (const window of this.windows) {
          const match = window.tabs.allTabs().find((tab) => tab.contents?.id === webContentsId)
          if (match) return { tabId: match.id, title: match.snapshot.title || match.snapshot.url }
        }
        return null
      }
    })
    this.permissions.start()
    this.snapshots.start()
    this.memory.start()
    // Starts only if the user has switched Slash Coin on; `sync` is a no-op
    // otherwise, so a default install never runs the sampler at all.
    this.activity.sync()
    void this.rewards.refreshState()
    this.offerRewardsOnce()
    // Loading the model and backfilling are both slow and both entirely
    // optional, so this is not awaited: startup must not wait on a feature the
    // user may never search with this session.
    this.semantic.syncWithSettings()

    registerHandlers(this)

    this.settings.onChange((next) => {
      this.broadcastAll('settings:changed', next)
      this.activity.sync()

      // Which page scripts are installed is decided once per debugger
      // attachment, so a tab already open would otherwise keep whatever was
      // decided when it attached — a feature switched on and nothing happening.
      const scriptSwitches = [
        next.allowPageScripts,
        next.blockAds,
        next.blockYouTubeVideoAds,
        next.restoreContextMenu,
        next.blockPopups
      ].join('|')
      if (scriptSwitches !== this.lastScriptSwitches) {
        this.lastScriptSwitches = scriptSwitches
        this.injector.refresh(this.allPageContents())
      }
      // Switching Slash Coin on is the first moment the browser is allowed to
      // ask the rewards service anything, so the rate and the daily maximum are
      // fetched here rather than at launch. Before this, the page deliberately
      // shows no figures: requesting them would be a call to our own server
      // from a browser whose owner has not opted in.
      if (next.rewardsEnabled && !this.rewardsWasEnabled) void this.rewards.refreshState()
      this.rewardsWasEnabled = next.rewardsEnabled
      // Keep each window's policy in step with the setting.
      for (const window of this.windows) {
        window.performance.policy.setMode(
          effectiveMode(
            next.performanceMode,
            describeMachine(readMachine()),
            next.hardwareOptimisation
          )
        )
        // Moving the tab strip changes how far the native page view is inset.
        // React redrawing alone would leave the page covering the new column.
        window.applySidebarWidth()
      }
      // The toggle is the switch; changing it anywhere — settings panel, memory
      // panel, a future import — starts or stops the layer.
      this.semantic.syncWithSettings()
    })

    // GPU and utility-process crashes never reach a tab's handler, so they are
    // caught at the app level or they are lost entirely.
    app.on('child-process-gone', (_event, details) => {
      this.crashes.record(details.type, details.reason, details.exitCode ?? null)
    })
    app.on('render-process-gone', (_event, _contents, details) => {
      this.crashes.record('renderer', details.reason, details.exitCode ?? null)
    })

    // Deliberately not awaited. Compiling the lists takes ~900ms in a utility
    // process on first run; deserialising the cache takes ~7ms after that.
    // Either way the browser opens and browses immediately, with the domain
    // lists covering the gap until this is ready.
    void this.blocker.adblock.load()

    // Extensions are re-loaded on every boot: Electron discards them at exit,
    // so the remembered folder paths are the only durable reference. Not
    // awaited — a folder that has since been deleted must not delay startup.
    void this.extensions.attach(this.sessions.getDefault())

    // Inert unless the user switched tiles on *and* an operator configured an
    // endpoint. With either missing this makes no request at all.
    void this.sponsor.refresh()

    this.started = true
    log.info('context started')
  }

  /**
   * Opens a window.
   *
   * A private window uses the in-memory session and records nothing: no
   * history, no browsing memory, no closed-tab entries, and it is excluded from
   * session snapshots. Those are four separate write paths, and privacy that
   * covers three of them is not privacy.
   */
  createWindow(options: { isPrivate?: boolean } = {}): BrowserWindowController {
    const isPrivate = options.isPrivate === true
    const window = new BrowserWindowController({
      isPrivate,
      ipc: this.ipc,
      sessions: this.sessions,
      history: this.history,
      workspaces: this.workspaces,
      settings: this.settings,
      downloads: this.downloads,
      onTabsChanged: () => this.snapshots.noteChange(),
      onTabDiscarded: (tabId) => {
        this.permissions.cancelForTab(tabId)
        // Drop sign-in-form records for pages that no longer exist. Reads are
        // keyed by the current webContents id so a stale entry could never be
        // used, but a map that only ever grows is still a leak.
        const live = new Set(
          this.windows.flatMap((w) =>
            w.tabs
              .allTabs()
              .map((t) => t.contents?.id)
              .filter((id): id is number => id !== undefined)
          )
        )
        for (const id of this.loginForms.keys()) {
          if (!live.has(id)) this.loginForms.delete(id)
        }
      },
      // Written through on close rather than flushed at quit: a crash is one of
      // the times you most want a tab back, and a shutdown flush never runs.
      // A private tab's address must not survive it. Reopen-closed-tab is
      // persisted, so recording one here would outlive the window itself.
      onTabClosed: (entry) => {
        if (isPrivate) return
        this.closedTabs.add(entry)
      },
      takeClosedTab: () => {
        const record = this.closedTabs.takeLatest()
        return record ? { ...record } : null
      },
      // Written through on every change. A group is the product of someone
      // naming and sorting things, and losing that to a crash teaches them not
      // to bother doing it again.
      // Per-site zoom. Only non-default levels are stored: resetting a site to
      // 100% drops its entry rather than saving a zero, so the map does not grow
      // an entry for every site ever visited.
      siteZoomFor: (url) => {
        const host = hostOf(url)
        if (!host) return null
        const level = this.settings.getAll().siteZoom[host]
        return typeof level === 'number' && level !== 0 ? level : null
      },
      onSiteZoomChanged: (url, level) => {
        const host = hostOf(url)
        if (!host || isPrivate) return
        const siteZoom = { ...this.settings.getAll().siteZoom }
        if (level === 0) delete siteZoom[host]
        else siteZoom[host] = level
        this.settings.update({ siteZoom })
      },
      onGroupsChanged: (groups) => {
        if (isPrivate) return
        this.tabGroups.pruneExcept(groups.map((g) => g.id))
        for (const group of groups) {
          this.tabGroups.delete(group.id)
          this.tabGroups.create(group)
        }
      },
      onPageLoaded: (contents, url) => {
        // The gate has always taken this flag; until now there was no private
        // window to pass `true` from.
        void this.memory.indexPage(contents, url, isPrivate)

        // Mission Mode records the visit and may offer to save a digression. It
        // never blocks: the suggestion is the entire intervention.
        const suggestion = this.missions.notePageVisited(url, contents.getTitle())
        for (const window of this.windows) {
          const tab = window.tabs.allTabs().find((candidate) => candidate.contents === contents)
          if (!tab) continue
          if (suggestion) {
            this.missionSuggestions.set(tab.id, suggestion)
            this.broadcastAll('mission:suggestion', { url, suggestion })
          } else {
            this.missionSuggestions.delete(tab.id)
          }
        }

        // A watched page is compared when the user visits it, never by polling —
        // a browser re-fetching a list of URLs on a timer makes requests nobody
        // asked for and looks like a crawler in the site's logs.
        void this.watch.checkPage(contents, url).then((change) => {
          if (change) this.broadcastAll('watch:changed', { url, change })
        })

        // A new document carries none of the injected cleanup CSS, so any tab
        // showing this page is no longer cleaned. Continuing to report it as
        // cleaned would leave a Restore button that does nothing.
        for (const window of this.windows) {
          const tab = window.tabs.allTabs().find((candidate) => candidate.contents === contents)
          if (tab) this.cleanup.forget(tab.id)
        }
      },
      enqueueDownload: (url, contents) =>
        this.downloadEngine.enqueue(url, { context: this.mediaContextFor(contents) }),
      // Offered only where the page reported address fields, so the entry never
      // appears on a comment box or a search bar.
      addressOffers: (contents) => {
        if ((this.addressForms.get(contents.id) ?? []).length === 0) return []
        return this.addresses.list().map((address, index) => ({
          id: address.id,
          label:
            address.label.trim() !== ''
              ? address.label
              : [address.streetLine1, address.city].filter((part) => part !== '').join(', ') ||
                `Address ${index + 1}`
        }))
      },
      fillAddress: (contents, id) => {
        const address = this.addresses.get(id)
        if (!address) return
        const present = (this.addressForms.get(contents.id) ?? []) as AddressFieldKind[]
        void this.addressFiller.fill(contents, address, present)
      },
      observeYouTube: (contents) => {
        this.injector.observe(contents)
        this.cosmetics.observe(contents)
      },
      observeMedia: (contents) => {
        this.mediaSniffer.observe(contents)
        this.watchForSignIn(contents)
      },
      mediaOffer: (window) => this.mediaOfferFor(window),
      isKnownAdHost: (host) => this.blocker.engine.isKnownAdHost(host),
      onRedirectChain: (chain) => {
        // Only chains worth attention are pushed. Broadcasting every http→https
        // hop would make the event useless and the panel unreadable.
        if (chain.verdict === 'suspicious' || chain.verdict === 'notable') {
          this.broadcastAll('redirects:chain', chain)
        }
      },
      onBookmarkRequested: (url, title) => {
        if (this.bookmarks.findByUrl(url)) return
        this.bookmarks.create({ url, title, faviconUrl: null, parentId: null, isFolder: false })
        const all = this.bookmarks.list()
        for (const window of this.windows) {
          this.ipc.broadcast('bookmarks:changed', all, window.privilegedContents())
        }
      },
      shouldAllowPopup: (tabId, url, pageUrl, webContentsId) => {
        if (!this.settings.getAll().blockPopups) return true
        const verdict = this.popups.evaluate({
          webContentsId,
          targetUrl: url,
          pageUrl,
          mode: this.settings.getAll().protectionMode,
          siteLocked: this.siteLockedTabs.has(tabId)
        })
        return verdict.action === 'allow'
      },
      shouldAllowNavigation: (tabId, url, pageUrl, webContentsId) =>
        this.redirects.evaluate({
          webContentsId,
          targetUrl: url,
          currentUrl: pageUrl,
          mode: this.settings.getAll().protectionMode,
          siteLocked: this.siteLockedTabs.has(tabId)
        })
    })
    // Catch the new window's recorder up on every session already in use.
    for (const { session, label } of this.observedSessions) {
      window.redirectRecorder.attachToSession(session, label)
    }
    this.windows.push(window)

    // The only trigger the clipboard watcher has. Never a timer: a background
    // poll would read the clipboard of whatever application the user is
    // actually working in, and this reads it only at the moment they have
    // deliberately come back to the browser.
    window.browserWindow.on('focus', () => this.clipboard.check())
    // `close` fires while the views are still alive; `closed` fires after the
    // window is gone and has already been removed from this.windows, which is
    // too late for the session-end snapshot to see any tabs.
    window.browserWindow.on('close', () => {
      this.snapshots.retainClosingWindow(window)
    })
    window.browserWindow.on('closed', () => {
      const index = this.windows.indexOf(window)
      if (index >= 0) this.windows.splice(index, 1)
    })
    return window
  }

  allWindows(): readonly BrowserWindowController[] {
    return this.windows
  }

  /**
   * URL of the page a WebContents is showing.
   *
   * Read from the live contents rather than our tab snapshot, because a request
   * can fire mid-navigation, before the snapshot has caught up.
   */
  /** The window owning a page view, so a block is reported where it happened. */
  private windowForContents(webContentsId: number): BrowserWindowController | null {
    for (const window of this.windows) {
      const match = window.tabs.allTabs().find((tab) => tab.contents?.id === webContentsId)
      if (match) return window
    }
    return null
  }

  /**
   * Carries out "when every download finishes, do this".
   *
   * Everything except `notify` ends the session, so none of it happens
   * immediately: the user gets `COMPLETION_GRACE_MS` and a notification they
   * can click to call it off. A download manager that switches a machine off
   * with no way to stop it is a download manager nobody leaves running.
   *
   * The commands are Windows' own. There is no Electron API for sleep or
   * shutdown, and shelling out is the honest way to say so - if the platform
   * ever differs, this is the one place that has to learn about it.
   */
  private async runCompletionAction(action: CompletionAction): Promise<void> {
    if (action === 'nothing') return

    const label =
      action === 'quit' ? 'close Slash' : action === 'sleep' ? 'sleep' : action === 'shutdown' ? 'shut down' : ''

    if (action === 'notify') {
      new Notification({
        title: 'Downloads finished',
        body: 'Everything in the queue has completed.'
      }).show()
      return
    }

    this.completionPending = true
    new Notification({
      title: 'Downloads finished',
      body: `This machine will ${label} in ${Math.round(COMPLETION_GRACE_MS / 1000)} seconds. Open Slash to cancel.`
    }).show()

    await new Promise((resolve) => setTimeout(resolve, COMPLETION_GRACE_MS))
    // Cancelled while the countdown ran - a new download, or the user saying no.
    if (!this.completionPending) return
    this.completionPending = false

    if (action === 'quit') {
      app.quit()
      return
    }
    if (action === 'sleep') {
      exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0')
      return
    }
    exec('shutdown /s /t 0')
  }

  /** Stops a pending shutdown or sleep. */
  cancelCompletionAction(): void {
    this.completionPending = false
  }

  private completionPending = false

  /**
   * What qualities the page's own player offers.
   *
   * Hostname-gated through `pageMedia.canExtract`, and only ever from an
   * explicit click, for the same reason `PageMediaExtractor` is: running a
   * script in a page's own world is a capability to keep narrow.
   */
  async playerQualitiesFor(window: BrowserWindowController): Promise<{
    available: boolean
    levels: { level: string; label: string; current: boolean }[]
    note: string | null
  }> {
    const contents = window.tabs.activeTab?.contents ?? null
    if (!contents || !this.pageMedia.canExtract(contents)) {
      return { available: false, levels: [], note: null }
    }

    try {
      const read = (await contents.executeJavaScript(READ_QUALITIES_SCRIPT, true)) as {
        ok: boolean
        levels: string[]
        current: string
        canSet?: boolean
      }
      if (!read?.ok) {
        return {
          available: false,
          levels: [],
          note: 'The player on this page has not finished loading. Start the video, then try again.'
        }
      }
      return {
        available: read.canSet !== false,
        levels: playerQualities(read.levels ?? [], read.current ?? ''),
        note: null
      }
    } catch {
      return { available: false, levels: [], note: null }
    }
  }

  /**
   * Asks the player for a quality, then waits for it to fetch some of it.
   *
   * The wait is the point, and it is why this cannot be instant. This site
   * publishes no addresses on the page, so the only way a quality becomes
   * downloadable is for the player to actually request it — the sniffer then
   * sees those responses. Switching and reading back immediately finds nothing,
   * every time.
   */
  async requestPlayerQuality(
    window: BrowserWindowController,
    level: string
  ): Promise<{ ok: boolean; now: string; found: number; note: string }> {
    const contents = window.tabs.activeTab?.contents ?? null
    if (!contents || !this.pageMedia.canExtract(contents)) {
      return { ok: false, now: '', found: 0, note: 'This page has no player Slash can ask.' }
    }

    let now: string
    try {
      const result = (await contents.executeJavaScript(requestQualityScript(level), true)) as {
        ok: boolean
        now?: string
        reason?: string
      }
      if (!result?.ok) {
        return {
          ok: false,
          now: '',
          found: 0,
          note: result?.reason ?? 'The player would not change quality.'
        }
      }
      now = result.now ?? ''
    } catch (error) {
      return {
        ok: false,
        now: '',
        found: 0,
        note: error instanceof Error ? error.message : String(error)
      }
    }

    // Let the player fetch at the new quality. Its buffer is already full at
    // the old one, so nothing is requested until that drains - which is why
    // this waits seconds rather than milliseconds.
    await new Promise((resolve) => setTimeout(resolve, QUALITY_SETTLE_MS))

    // Read the quality back *now*, not immediately after the call. The switch
    // is not instant: asked for 720p the player still reported 1080p a moment
    // later, because it finishes the range it is already fetching first. The
    // early reading was simply wrong about what was playing.
    try {
      const settled = (await contents.executeJavaScript(
        `(() => { const p = document.querySelector('#movie_player'); return p && p.getPlaybackQuality ? p.getPlaybackQuality() : '' })()`,
        true
      )) as string
      if (typeof settled === 'string' && settled !== '') now = settled
    } catch {
      // Keep the earlier reading rather than losing it.
    }

    const options = await this.mediaOptionsFor(window)
    return {
      ok: true,
      now,
      found: options.choices.length,
      note:
        options.choices.length > 0
          ? `Playing at ${now || level}. ${options.choices.length} download${options.choices.length === 1 ? '' : 's'} available.`
          : `Playing at ${now || level}, but nothing has been fetched yet. Let it play for a few more seconds and open this again.`
    }
  }

  /**
   * What a user-installed yt-dlp says the current page is available as.
   *
   * Returns `available: false` with a reason rather than an empty list, so the
   * picker can tell "switched off" from "not installed" from "this page has
   * nothing" — three states that need three different sentences.
   */
  async externalFormatsFor(window: BrowserWindowController): Promise<{
    available: boolean
    title: string
    choices: { selector: string; label: string; ext: string; sizeText: string }[]
    note: string | null
  }> {
    const empty = { title: '', choices: [] as never[] }

    if (!this.settings.getAll().useExternalDownloader) {
      return { ...empty, available: false, note: null }
    }
    const url = window.tabs.activeTab?.contents?.getURL() ?? ''
    if (!/^https?:/i.test(url)) return { ...empty, available: false, note: null }

    if ((await this.ytDlp.locate()) === null) {
      return {
        ...empty,
        available: false,
        note:
          'yt-dlp is switched on but was not found. Install it and make sure it is on your PATH, ' +
          'or set its full path in Settings → Downloads.'
      }
    }

    const listed = await this.ytDlp.listFormats(url)
    if (!listed.ok) {
      return { ...empty, available: true, note: listed.error ?? 'yt-dlp could not read this page.' }
    }
    return {
      available: true,
      title: listed.title,
      choices: listed.choices.map((choice) => ({
        selector: choice.selector,
        label: choice.label,
        ext: choice.ext,
        sizeText: choice.sizeText
      })),
      note:
        listed.choices.length === 0
          ? 'yt-dlp found nothing downloadable on this page.'
          : 'Downloaded by yt-dlp, not by Slash.'
    }
  }

  /**
   * Hands one selector to yt-dlp and adopts the result into the downloads list.
   *
   * The row says who did the work. A download the browser could not make itself
   * appearing indistinguishably beside ones it did would be a quiet lie about
   * what this software is capable of.
   */
  async startExternalDownload(
    window: BrowserWindowController,
    selector: string,
    label: string
  ): Promise<{ started: boolean; note: string }> {
    if (!this.settings.getAll().useExternalDownloader) {
      return { started: false, note: 'The external downloader is switched off.' }
    }
    const contents = window.tabs.activeTab?.contents ?? null
    const url = contents?.getURL() ?? ''
    if (!/^https?:/i.test(url)) {
      return { started: false, note: 'There is no page to download from.' }
    }

    const directory = this.downloads.directory()
    const title = contents?.getTitle() ?? 'video'
    const adopted = this.downloadEngine.adoptExternal({
      url,
      filename: title,
      directory,
      connectionNote: `${label} · via yt-dlp`,
      onCancel: () => handle?.cancel()
    })

    const handle = this.ytDlp.start(url, selector, directory, {
      onProgress: (progress) =>
        adopted.progress(progress.downloadedBytes, progress.totalBytes, progress.bytesPerSecond),
      onDone: (result) => adopted.finish(result)
    })

    if (!handle) {
      adopted.finish({ ok: false, error: 'yt-dlp could not be started.', file: null })
      return { started: false, note: 'yt-dlp could not be started.' }
    }
    return { started: true, note: `Downloading ${label} with yt-dlp.` }
  }

  /** Whether a yt-dlp is available, and whether it is the one Slash fetched. */
  externalStatus(): Promise<{
    installed: boolean
    managed: boolean
    path: string | null
    version: string | null
  }> {
    return this.ytDlp.status()
  }

  installExternal(): Promise<{ ok: boolean; version: string | null; note: string }> {
    return this.ytDlp.install()
  }

  uninstallExternal(): Promise<{ ok: boolean; note: string }> {
    return this.ytDlp.uninstall()
  }

  pageUrlFor(webContentsId: number): string | null {
    for (const window of this.windows) {
      for (const tab of window.tabs.allTabs()) {
        const contents = tab.contents
        if (contents && !contents.isDestroyed() && contents.id === webContentsId) {
          return contents.getURL() || tab.snapshot.url
        }
      }
    }
    return null
  }

  /** Pushes the workspace list to one window after a change it did not make. */
  broadcastWorkspacesTo(window: BrowserWindowController): void {
    this.ipc.broadcast(
      'workspaces:snapshot',
      {
        workspaces: this.workspaces.list(),
        activeWorkspaceId: window.tabs.currentWorkspaceId
      },
      window.privilegedContents()
    )
  }

  /** The window containing a given tab. */
  windowForTab(tabId: string): BrowserWindowController | undefined {
    return this.windows.find((window) => window.tabs.findById(tabId) !== null)
  }

  /** Maps a privileged sender back to the window that owns it. */
  windowFor(sender: WebContents): BrowserWindowController | undefined {
    return this.windows.find((w) => w.privilegedContents().some((c) => c.id === sender.id))
  }

  /**
   * The single invitation to Slash Coin.
   *
   * Shown **once ever**, and marked seen the moment it is shown rather than
   * when it is acted on — a prompt that reappears until somebody says yes is a
   * nag, and principle 4 rules that out. Whoever dismisses it can still reach
   * the feature from Settings and from the start page.
   *
   * Delayed deliberately: at launch the user is opening the browser to do
   * something, and a toast about a rewards scheme in the first second is an
   * interruption rather than an offer.
   */
  private offerRewardsOnce(): void {
    const settings = this.settings.getAll()
    if (settings.rewardsEnabled || settings.rewardsPromptSeen) return

    const timer = setTimeout(() => {
      // Re-read: the user may have found it themselves in the meantime.
      const now = this.settings.getAll()
      if (now.rewardsEnabled || now.rewardsPromptSeen) return
      const window = this.windows.find((w) => w.isFocused) ?? this.windows[0]
      if (!window) return

      void this.settings.update({ rewardsPromptSeen: true })
      window.showNotice(
        'Earn Slash Coin for the time you spend browsing. Points only - no cash value.',
        'info',
        { label: 'Start earning', openUrl: REWARDS_URL }
      )
    }, REWARDS_INVITE_DELAY_MS)
    timer.unref?.()
  }

  /**
   * Catches the sign-in code wherever the browser actually lands.
   *
   * The loopback listener is the intended destination, and depending on it
   * alone turned out to be a mistake: when the provider cannot resolve its own
   * flow it redirects to *its* configured site address instead, which on this
   * project is `localhost:3000` and answers nothing. The code is right there in
   * that failed address, and since the sign-in now happens in a Slash tab, this
   * browser is the thing looking at it.
   *
   * `did-start-navigation` rather than a load event, because the navigation
   * being caught is one that is about to fail — there will be no document, no
   * `did-navigate`, and no page to read afterwards.
   *
   * Costs nothing when no sign-in is in flight: `completeSignIn` returns
   * immediately unless a verifier is waiting.
   */
  private watchForSignIn(contents: WebContents): void {
    /**
     * Both events, and that is the whole point.
     *
     * `did-start-navigation` fires once when a navigation begins.
     * A **server redirect** inside that navigation fires
     * `did-redirect-navigation` instead — and the sign-in ends in exactly that
     * way: Google redirects to the auth service, which redirects again to the
     * address carrying our code. Listening only to the first event meant the
     * browser watched the chain begin and never saw where it ended, which is
     * why a probe that navigated straight to the final address passed while the
     * real flow kept failing.
     */
    const consider = (url: string): void => {
      if (!this.rewards.awaitingCode) return
      // The loopback listener is answering this one itself. Stepping in here
      // would close it before the browser's request arrives.
      if (this.rewards.isOwnCallback(url)) return
      const code = codeFromRedirect(url, this.rewards.providerUrl)
      if (code === '') return
      void this.rewards.completeSignIn(url).then((result) => {
        if (!result.ok) {
          log.warn(`rewards: could not finish sign-in from a redirect: ${result.problem}`)
          return
        }
        log.info('rewards: signed in from a redirect the loopback never received')
        // The tab has done its job and is about to show a connection error for
        // an address that was never meant to be visited.
        const tab = this.windows
          .flatMap((window) => window.tabs.allTabs())
          .find((candidate) => candidate.contents?.id === contents.id)
        const window = tab ? this.windowForTab(tab.id) : null
        if (tab && window) window.tabs.close(tab.id)
        this.broadcastRewards()
      })
    }

    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      consider(details.url)
    })
    contents.on('did-redirect-navigation', (details) => {
      if (!details.isMainFrame) return
      consider(details.url)
    })
    // The last resort: the redirect landed somewhere that refused the
    // connection, so there is no document and no further navigation - but the
    // address that failed is still the one holding the code.
    contents.on('did-fail-load', (_event, _code, _desc, failedUrl, isMainFrame) => {
      if (!isMainFrame) return
      consider(failedUrl)
    })
  }

  /**
   * Closes the loop after a successful sign-in.
   *
   * The tab that carried the OAuth flow is sitting on a callback page that
   * exists only to receive a code — a dead end once it has. So it is sent to
   * the rewards page, which is where somebody who just signed in wants to be,
   * and a notice confirms it in case they had already switched tabs.
   *
   * Any tab still on a sign-in address is redirected, not just one: a retried
   * sign-in can leave more than one behind, and none of them is worth keeping.
   */
  private finishSignInUi(): void {
    const isSignInPage = (url: string): boolean =>
      /^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback/.test(url) ||
      url.startsWith('https://accounts.google.com/') ||
      url.includes('/auth/v1/authorize')

    let moved = false
    for (const window of this.windows) {
      for (const tab of window.tabs.allTabs()) {
        if (!isSignInPage(tab.snapshot.url)) continue
        window.tabs.navigate(tab.id, REWARDS_URL)
        moved = true
      }
    }

    const window = this.windows.find((w) => w.isFocused) ?? this.windows[0]
    window?.showNotice('Signed in to Slash Coin. Your balance is on the rewards page.', 'info', {
      label: 'Open Slash Coin',
      openUrl: REWARDS_URL
    })
    log.info(`rewards: sign-in complete${moved ? '; sign-in tab sent to the rewards page' : ''}`)
  }

  /** One place that assembles the rewards status, since three callers push it. */
  broadcastRewards(): void {
    this.broadcastAll('rewards:changed', this.rewards.status(this.activity.earning, this.activity.note))
  }

  /** Every page view currently alive, across every window. */
  private allPageContents(): Electron.WebContents[] {
    const out: Electron.WebContents[] = []
    for (const window of this.windows) {
      for (const tab of window.tabs.allTabs()) {
        const contents = tab.contents
        if (contents && !contents.isDestroyed()) out.push(contents)
      }
    }
    return out
  }

  focusedWindow(): BrowserWindowController | undefined {
    return this.windows.find((w) => w.isFocused) ?? this.windows[0]
  }

  /**
   * Pushes an event to every window's privileged views.
   *
   * Generic over the channel so the payload is checked against that channel's
   * contract — the previous hand-listed union needed a `never` cast, which meant
   * a mismatched payload would have compiled.
   */
  /**
   * The one file the floating chip should offer for a window, or null.
   *
   * Lives here rather than in the window because the sniffer is
   * application-wide. The window is told what to float; it does not go looking.
   *
   * Returns null unless the *active* tab has a complete file. A video playing
   * in a background tab is not a reason to put a chip over the page somebody is
   * reading, and a manifest or an encrypted stream is not something a chip can
   * honestly offer — those get the panel's sentence instead.
   */
  private mediaOfferFor(window: BrowserWindowController): MediaOffer | null {
    if (!this.settings.getAll().mediaOverlayButton) return null

    const contents = window.tabs.activeTab?.contents ?? null

    // A page that lists its own formats always has something to offer, and it
    // is the only thing that works on YouTube — where the network observer sees
    // byte ranges of a transport format rather than a file, which is exactly
    // why the chip never appeared there.
    if (this.pageMedia.canExtract(contents)) {
      return {
        url: '',
        filename: contents?.getTitle() ?? 'This video',
        sizeText: 'Choose a quality',
        others: 0
      }
    }

    // Cheap gate. This runs on every tab snapshot, and the common case is a
    // page with no video at all.
    if (this.mediaSniffer.knownCount(contents) === 0) return null

    const files = toDownloadable(this.mediaSniffer.forTab(contents))
    const best = files[0]
    if (!best) return null

    return {
      url: best.url,
      filename: suggestedFilename(best.url, 'file'),
      sizeText: formatSize(best.sizeBytes),
      others: files.length - 1
    }
  }

  /**
   * Everything the active page can be saved as, from both sources.
   *
   * The page's own list first when it has one: it knows the real resolutions and
   * byte lengths, where the network observer only knows what it happened to see.
   */
  async mediaOptionsFor(window: BrowserWindowController): Promise<{
    title: string
    choices: MediaOption[]
    note: string | null
  }> {
    const contents = window.tabs.activeTab?.contents ?? null

    // The page's own list wins when it has one — including when that list is
    // empty for a reason worth stating. Falling through to the network observer
    // there would replace a specific explanation with a vaguer one.
    const page = await this.pageMedia.extract(contents)
    if (page) {
      // With a muxer and an audio stream present, a picture-only row is no
      // longer half a video — it downloads as one file. Saying "no sound" then
      // would be describing a limitation that no longer applies.
      const canJoin = this.downloadEngine.canJoin()
      const hasAudio = page.choices.some((choice) => choice.hasAudio && !choice.hasVideo)
      const joinable = canJoin && hasAudio

      return {
        title: page.title,
        choices: page.choices.map((choice) => ({
          ...choice,
          complete: choice.complete || (joinable && choice.hasVideo),
          label:
            joinable && choice.hasVideo && !choice.hasAudio
              ? `${choice.label.replace(' · no sound', '')} · sound added`
              : choice.label,
          sizeText: formatSize(choice.size)
        })),
        // Only the "these are two halves" sentence stops being true when a
        // muxer is present. Anything else in the note — notably the count of
        // formats whose address is signed — still is, and nulling the whole
        // note to drop one sentence was why a page offering 360p and twenty
        // signed formats explained nothing at all.
        note: joinable ? withoutSeparateStreamsNote(page.note) : page.note
      }
    }

    const sniffed = this.mediaSniffer.forTab(contents)
    const files = toDownloadable(sniffed)
    const context = this.mediaContextFor(contents)

    const choices: MediaOption[] = []
    for (const file of files) {
      // A master playlist is a *list of qualities*, and offering it as one row
      // called "HLS stream" is the whole "I cannot choose the quality"
      // complaint: the downloader silently took the biggest variant, which on a
      // film site is often not the one somebody wants and is never the one they
      // were asked about.
      if (file.container === 'stream') {
        const variants = await this.streamVariants(file.url, context)
        if (variants.length > 0) {
          for (const variant of variants) {
            choices.push({
              url: variant.url,
              label: `${qualityLabel(variant)} · joined on download`,
              size: null,
              mimeType: 'video/mp2t',
              hasVideo: true,
              hasAudio: true,
              complete: true,
              // The playlist has no length of its own and the segments are not
              // listed until it is read, so the honest figure is the bitrate.
              sizeText: bitrateText(variant.bandwidth),
              streamHint: { bandwidth: variant.bandwidth, quality: variant.resolution },
              isStream: true
            })
          }
          continue
        }
      }

      choices.push({
        url: file.url,
        label: file.label,
        size: file.sizeBytes,
        mimeType: file.container === null ? '' : `video/${file.container}`,
        hasVideo: file.kind === 'video',
        hasAudio: file.kind === 'audio',
        complete: true,
        sizeText: formatSize(file.sizeBytes),
        isStream: file.container === 'stream'
      })
    }

    // Two players on one page routinely point at the same master, and the same
    // variant then appears twice under two identical labels.
    const seen = new Set<string>()
    const unique = choices.filter((choice) => !seen.has(choice.url) && seen.add(choice.url))

    // When everything on offer came off the wire from an adaptive player, the
    // qualities listed are the ones that have actually **played** - not the
    // ones the site has. YouTube starts low and climbs, so a video opened and
    // downloaded straight away offers 360p and nothing else, which reads as
    // "Slash can only do 360p".
    //
    // The page cannot help here: measured on a real watch page, all thirty
    // formats carried no address at all. So the lever really is the player's
    // own quality menu, and saying so is the difference between a limitation
    // somebody can work around and one that looks like a bug.
    const adaptiveOnly =
      unique.length > 0 && unique.every((choice) => isExpiringMediaHost(choice.url))

    return {
      title: contents?.getTitle() ?? '',
      choices: unique,
      note:
        unique.length > 0
          ? adaptiveOnly
            ? 'These are the qualities this player has actually downloaded so far. This site ' +
              'publishes no addresses on the page, so Slash can only offer what has played — set ' +
              'the quality you want in the player, let it run for a few seconds, then open this ' +
              'again. Addresses from this site also expire after a few hours.'
            : null
          : sniffNoteFor(sniffed)
    }
  }

  /**
   * Replaces each master playlist in a scan with the qualities it lists.
   *
   * The Downloads panel showed one row per stream called "HLS stream", and the
   * downloader then took the highest-bitrate variant without asking. That is
   * the "I cannot choose the quality" complaint exactly: the choice existed in
   * the playlist all along and was being made silently on the user's behalf.
   *
   * Best effort. A playlist that will not load leaves its row exactly as it
   * was, because one unreadable master must not empty a list that had other
   * things in it.
   */
  async withStreamQualities(
    candidates: readonly MediaCandidate[],
    contents: WebContents | null
  ): Promise<MediaCandidate[]> {
    const context = this.mediaContextFor(contents)
    const expanded: MediaCandidate[] = []

    for (const candidate of candidates) {
      if (candidate.container !== 'stream') {
        expanded.push(candidate)
        continue
      }
      const variants = await this.streamVariants(candidate.url, context)
      if (variants.length === 0) {
        expanded.push(candidate)
        continue
      }
      for (const variant of variants) {
        expanded.push({
          url: variant.url,
          kind: 'video',
          container: 'stream',
          resolution: `${qualityLabel(variant)} · ${bitrateText(variant.bandwidth)}`,
          sizeBytes: null,
          label: `${qualityLabel(variant)} · joined on download`
        })
      }
    }

    const seen = new Set<string>()
    return expanded.filter((candidate) => !seen.has(candidate.url) && seen.add(candidate.url))
  }

  /**
   * What a master playlist said about a variant, found by its own address.
   *
   * Looked up rather than sent through the renderer: the bitrate only feeds a
   * size estimate, and a number the renderer could choose is a number the
   * renderer could get wrong. The cache is at most 32 playlists, so scanning it
   * is cheaper than the parse that would rebuild it.
   */
  /**
   * Whether this address is a playlist, according to something that saw it.
   *
   * The sniffer classified the response by its `Content-Type`, and the variant
   * cache holds addresses read out of a master playlist. Both know for certain
   * what the URL alone cannot say — these CDNs serve HLS from paths with no
   * extension, and the Downloads panel's own button was sending them down the
   * file path as a result.
   */
  isKnownStream(url: string, contents: WebContents | null): boolean {
    if (this.streamHintFor(url) !== undefined) return true
    return this.mediaSniffer
      .forTab(contents)
      .some((item) => item.url === url && item.kind === 'stream')
  }

  streamHintFor(url: string): { bandwidth?: number; quality?: string | null } | undefined {
    for (const entry of this.variantCache.values()) {
      const found = entry.variants.find((variant) => variant.url === url)
      if (found) return { bandwidth: found.bandwidth, quality: found.resolution }
    }
    return undefined
  }

  /**
   * The qualities behind a master playlist, remembered briefly.
   *
   * Cached because the picker asks twice for every download — once to show the
   * list and once to check the chosen URL was on it — and a second fetch of the
   * same playlist to answer the same question is a request the user did not ask
   * for. Short enough that a token-signed playlist is re-read rather than
   * replayed from a stale copy.
   */
  private async streamVariants(
    masterUrl: string,
    context: MediaRequestContext | undefined
  ): Promise<StreamQuality[]> {
    const cached = this.variantCache.get(masterUrl)
    if (cached && Date.now() - cached.at < VARIANT_CACHE_MS) return cached.variants

    const variants = await readStreamVariants(masterUrl, context)
    this.variantCache.set(masterUrl, { at: Date.now(), variants })
    // Bounded: a long session on a site that swaps players would otherwise keep
    // every playlist it ever read.
    if (this.variantCache.size > 32) {
      const oldest = [...this.variantCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) this.variantCache.delete(oldest[0])
    }
    return variants
  }

  private readonly variantCache = new Map<string, { at: number; variants: StreamQuality[] }>()

  /**
   * The page a download came from, so its requests are the page's own.
   *
   * Every media host worth downloading from checks at least one of these, and a
   * download that omits them is a different client asking for the same bytes:
   * `googlevideo.com` refuses it outright, and every film CDN refuses it on the
   * missing `Referer` alone. Nothing here is invented — the tab really is the
   * referrer, the session really is the one that fetched the page, and the user
   * agent really is this browser's.
   *
   * Returns undefined for anything that is not an ordinary web page, so an
   * internal or `file://` address is never sent to a remote server as a
   * referrer.
   */
  mediaContextFor(contents: WebContents | null | undefined): MediaRequestContext | undefined {
    if (!contents || contents.isDestroyed()) return undefined

    const pageUrl = contents.getURL()
    let origin: string | undefined
    try {
      const parsed = new URL(pageUrl)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin
    } catch {
      origin = undefined
    }
    // The partition, not just the session: a download that outlives this tab
    // has to be able to ask Chromium for the same cookie jar by name.
    const partition = this.sessions.partitionOf(contents.session) ?? undefined
    if (origin === undefined) {
      return { session: contents.session, partition, userAgent: contents.getUserAgent() }
    }

    return {
      session: contents.session,
      partition,
      referer: pageUrl,
      origin,
      userAgent: contents.getUserAgent()
    }
  }

  /**
   * The request context for a *specific* media address on this tab.
   *
   * Different from `mediaContextFor`, and the difference is the whole fix for a
   * class of 403s. Film sites put the player in a cross-origin iframe: the tab
   * sits on `123moviesfree.net` while the segments are requested by
   * `if9.ppzj-youtube.cfd`. The CDN checks its referrer against the **player's**
   * origin, so downloading with the tab's URL as referrer makes a different
   * claim from the one the player made, and these hosts answer that with 403 —
   * which is exactly what the Downloads panel was reporting.
   *
   * The sniffer already recorded which frame asked for each address. This uses
   * it, and falls back to the tab when it did not.
   */
  mediaContextForUrl(
    contents: WebContents | null,
    mediaUrl: string
  ): MediaRequestContext | undefined {
    const base = this.mediaContextFor(contents)
    if (!base) return undefined

    const seen = this.mediaSniffer
      .forTab(contents)
      .find((item) => item.url === mediaUrl || mediaIdentity(item.url) === mediaIdentity(mediaUrl))
    const frameUrl = seen?.frameUrl ?? ''
    if (frameUrl === '') return base

    let origin: string
    try {
      const parsed = new URL(frameUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return base
      origin = parsed.origin
    } catch {
      return base
    }
    // Same origin as the tab already: nothing to change.
    if (origin === base.origin) return base

    return { ...base, referer: frameUrl, origin }
  }

  /**
   * Folders this process has offered from a native chooser.
   *
   * The renderer sends back a path when the user picks one, and a path from an
   * untrusted sender is a write to anywhere on the disk. Rather than validating
   * a string, the answer is remembered: only a directory that came *out* of a
   * dialog here can go back *in*.
   *
   * Bounded, and it does not need to be large — the question is only ever
   * asked about the folder chosen moments ago.
   */
  private readonly offeredFolders = new Set<string>()

  /**
   * The save dialog for a download taken over from Chromium.
   *
   * A file chooser rather than a folder chooser, because that is what the
   * setting promises and what Chromium's own dialog does: the name is editable
   * too. Split back into a directory and a filename, both of which the engine
   * re-checks — `confinedPath` does not trust this any more than anything else.
   */
  async askWhereToSave(
    suggested: string
  ): Promise<{ directory: string; filename: string } | null> {
    const { dialog } = await import('electron')
    const parent = this.focusedWindow()?.browserWindow ?? null
    const options = {
      title: 'Save as',
      defaultPath: join(this.downloads.directory(), suggested)
    }
    const result = await (parent
      ? dialog.showSaveDialog(parent, options)
      : dialog.showSaveDialog(options))
    if (result.canceled || !result.filePath) return null

    const directory = dirname(result.filePath)
    this.offeredFolders.add(directory)
    return { directory, filename: basename(result.filePath) }
  }

  /** Whether this exact folder came from a chooser we opened. */
  wasFolderOffered(directory: string): boolean {
    return this.offeredFolders.has(directory)
  }

  /**
   * Asks the user for a folder, and remembers what was offered.
   *
   * Null when they cancelled, which is an ordinary outcome — the caller keeps
   * whatever folder it had rather than treating it as a failure.
   */
  async chooseDownloadFolder(parent: BaseWindow | null): Promise<string | null> {
    const { dialog } = await import('electron')
    const result = await (parent
      ? dialog.showOpenDialog(parent, {
          title: 'Save downloads to',
          defaultPath: this.downloads.directory(),
          properties: ['openDirectory', 'createDirectory']
        })
      : dialog.showOpenDialog({
          title: 'Save downloads to',
          defaultPath: this.downloads.directory(),
          properties: ['openDirectory', 'createDirectory']
        }))

    const chosen = result.canceled ? null : (result.filePaths[0] ?? null)
    if (chosen !== null) {
      if (this.offeredFolders.size > 32) this.offeredFolders.clear()
      this.offeredFolders.add(chosen)
    }
    return chosen
  }

  /** Names a chosen file after the page, not after the endpoint it came from. */
  filenameForChoice(title: string, choice: { label: string; mimeType: string; hasVideo: boolean }): string {
    const quality = choice.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
    const base = title.trim() === '' ? 'video' : title
    return `${base}${quality === '' ? '' : ` (${quality})`}.${extensionFor(choice.mimeType, choice.hasVideo)}`
  }

  private broadcastAll<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
    for (const window of this.windows) {
      this.ipc.broadcast(channel, payload, window.privilegedContents())
    }
  }

  get windowCount(): number {
    return this.windows.length
  }

  shutdown(): void {
    if (!this.started) return
    log.info('shutting down')
    for (const window of [...this.windows]) window.destroy()
    this.windows.length = 0
    this.disposeContentSignals?.()
    this.disposeContentSignals = null
    // Settles every pending prompt as denied; an unresolved permission promise
    // would leave the page's callback hanging.
    this.permissions.stop()
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.sponsorNotices.stop()
    this.mediaKeys.stop()
    void this.printing.cleanup()
    // Kills the utility process. Not awaited — `will-quit` is synchronous and
    // the child is killed outright if it does not answer, so there is nothing
    // to wait for that would change the outcome.
    this.downloadEngine.dispose()
    void this.semantic.stop()
    this.memory.stop()
    this.downloads.dispose()
    // Banks the open interval while the database is still open. Quitting
    // should not cost somebody the stretch they were in the middle of.
    this.activity.dispose()
    this.rewards.dispose()
    this.ipc.dispose()
    this.db.close()
    this.started = false
  }
}
