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
import { SessionSnapshotManager } from './snapshots/SessionSnapshotManager'
import { MemoryRepository } from './db/repositories/MemoryRepository'
import { MemoryIndexer } from './memory/MemoryIndexer'
import { AiEngine } from './ai/AiEngine'
import { ContentBlocker } from './shield/NetworkPolicy'
import { PopupGuard } from './shield/PopupGuard'
import { RedirectGuard } from './shield/RedirectGuard'
import { GestureTracker } from './shield/GestureTracker'
import { registerHandlers } from './ipc/handlers'
import { BrowserWindowController } from './windows/BrowserWindowController'
import { createLogger } from './logger'

const log = createLogger('app')

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
  readonly snapshots: SessionSnapshotManager
  readonly memoryRepository: MemoryRepository
  readonly memory: MemoryIndexer
  readonly ai: AiEngine
  readonly blocker: ContentBlocker
  readonly popups: PopupGuard
  readonly redirects: RedirectGuard
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
  private disposeContentSignals: (() => void) | null = null
  private started = false

  constructor() {
    this.db = new Database(app.getPath('userData'))
    this.settings = new SettingsStore(this.db)
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
    this.memory = new MemoryIndexer(this.memoryRepository, this.settings)
    this.ai = new AiEngine(this.settings, this.db)
    // Hooks are replaced in start(); until then a blocked navigation has no UI
    // to report to, but the request is still refused.
    this.blocker = new ContentBlocker(this.settings, {
      onMaliciousNavigation: () => {},
      onCountsChanged: () => {},
      resolvePageUrl: (webContentsId) => this.pageUrlFor(webContentsId)
    })
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
    this.snapshotRepository = new SnapshotRepository(this.db)
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
    this.downloads = new DownloadManager(this.downloadRepository, this.settings, {
      onChanged: (items) => this.broadcastAll('downloads:changed', items),
      getWindow: () => this.focusedWindow()?.browserWindow ?? null
    })
  }

  start(): void {
    if (this.started) return
    this.db.open()
    this.settings.load()

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
      { onUserGesture: (webContentsId) => this.popups.noteGesture(webContentsId) }
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
      }
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

    registerHandlers(this)

    this.settings.onChange((next) => {
      this.broadcastAll('settings:changed', next)
      // Keep each window's policy in step with the setting.
      for (const window of this.windows) window.performance.policy.setMode(next.performanceMode)
    })

    this.started = true
    log.info('context started')
  }

  createWindow(): BrowserWindowController {
    const window = new BrowserWindowController({
      ipc: this.ipc,
      sessions: this.sessions,
      history: this.history,
      workspaces: this.workspaces,
      settings: this.settings,
      downloads: this.downloads,
      onTabDiscarded: (tabId) => this.permissions.cancelForTab(tabId),
      onPageLoaded: (contents, url) => {
        // Private-window support is not built yet, so `false` is the truthful
        // value here rather than a placeholder — the flag exists so the gate is
        // already correct when it is.
        void this.memory.indexPage(contents, url, false)
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
    this.windows.push(window)
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
    this.downloads.dispose()
    this.ipc.dispose()
    this.db.close()
    this.started = false
  }
}
