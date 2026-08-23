import { SponsorNoticeService } from './sponsor/SponsorNoticeService'
import type { ProfileRegistry } from './profiles/ProfileRegistry'
import type { AddressFieldKind } from '@shared/addressFields'
import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import { Database } from './db/Database'
import { HistoryRepository } from './db/repositories/HistoryRepository'
import { BookmarkRepository } from './db/repositories/BookmarkRepository'
import { DownloadRepository } from './db/repositories/DownloadRepository'
import { WorkspaceRepository } from './db/repositories/WorkspaceRepository'
import { SettingsStore } from './settings/SettingsStore'
import { SessionHardening } from './sessions/SessionHardening'
import { SessionRegistry } from './sessions/SessionRegistry'
import { DownloadManager } from './downloads/DownloadManager'
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
import { BrowserWindowController } from './windows/BrowserWindowController'
import type { MediaOffer } from './windows/BrowserWindowController'
import { CrashReporting } from './diagnostics/CrashReporting'
import { UpdateService } from './updates/UpdateService'
import { PageWatchService } from './snapshots/PageWatchService'
import { MissionService } from './missions/MissionService'
import { createLogger } from './logger'

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
  readonly guardian: DownloadGuardian
  readonly mediaSniffer: MediaSniffer
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
    this.downloadEngine = new DownloadQueue(
      () => this.downloads.directory(),
      () => this.settings.getAll().downloadConnections,
      () => this.settings.getAll().downloadBandwidthLimit,
      (items) => this.broadcastAll('downloadEngine:changed', items)
    )
    this.crashes = new CrashReporting(this.db)
    this.updates = new UpdateService(() => this.settings.getAll().updateFeedUrl)
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
    this.mediaKeys = new MediaKeyService(
      this.settings,
      () => this.allWindows(),
      () => this.focusedWindow() ?? null
    )
    this.injector.register({
      id: 'youtube-ads',
      enabled: () =>
        this.settings.getAll().blockAds && this.settings.getAll().blockYouTubeVideoAds,
      source: buildYouTubeAdScript
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
    this.sponsor = new SponsorService(this.db, this.settings)
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
    // Loading the model and backfilling are both slow and both entirely
    // optional, so this is not awaited: startup must not wait on a feature the
    // user may never search with this session.
    this.semantic.syncWithSettings()

    registerHandlers(this)

    this.settings.onChange((next) => {
      this.broadcastAll('settings:changed', next)
      // Keep each window's policy in step with the setting.
      for (const window of this.windows) {
        window.performance.policy.setMode(next.performanceMode)
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
      enqueueDownload: (url) => this.downloadEngine.enqueue(url),
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
      observeMedia: (contents) => this.mediaSniffer.observe(contents),
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
    // Cheap gate first. This runs on every tab snapshot, and the common case is
    // a page with no video at all.
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
    this.ipc.dispose()
    this.db.close()
    this.started = false
  }
}
