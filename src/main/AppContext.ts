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
import { PermissionRepository } from './db/repositories/PermissionRepository'
import { PermissionManager } from './permissions/PermissionManager'
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
    this.downloadRepository = new DownloadRepository(this.db)
    this.sessions = new SessionRegistry(this.hardening)
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
    this.disposeContentSignals = installContentSignalListener((webContentsId) => {
      for (const window of this.windows) {
        const match = window.tabs.allTabs().find((tab) => tab.contents?.id === webContentsId)
        if (match) return match
      }
      return null
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
      onBookmarkRequested: (url, title) => {
        if (this.bookmarks.findByUrl(url)) return
        this.bookmarks.create({ url, title, faviconUrl: null, parentId: null, isFolder: false })
        const all = this.bookmarks.list()
        for (const window of this.windows) {
          this.ipc.broadcast('bookmarks:changed', all, window.privilegedContents())
        }
      }
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
