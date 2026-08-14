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
      downloads: this.downloads
    })
    this.windows.push(window)
    window.browserWindow.on('closed', () => {
      const index = this.windows.indexOf(window)
      if (index >= 0) this.windows.splice(index, 1)
    })
    return window
  }

  /** Maps a privileged sender back to the window that owns it. */
  windowFor(sender: WebContents): BrowserWindowController | undefined {
    return this.windows.find((w) => w.privilegedContents().some((c) => c.id === sender.id))
  }

  focusedWindow(): BrowserWindowController | undefined {
    return this.windows.find((w) => w.isFocused) ?? this.windows[0]
  }

  private broadcastAll<C extends 'settings:changed' | 'downloads:changed'>(
    channel: C,
    payload: Parameters<IpcRegistry['broadcast']>[1]
  ): void {
    for (const window of this.windows) {
      this.ipc.broadcast(channel, payload as never, window.privilegedContents())
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
    this.downloads.dispose()
    this.ipc.dispose()
    this.db.close()
    this.started = false
  }
}
