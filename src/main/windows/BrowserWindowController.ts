import { join } from 'node:path'
import { BaseWindow, WebContentsView, shell, type WebContents } from 'electron'
import { VIEW_KIND, WORKSPACE_RAIL_WIDTH } from '@shared/constants'
import { NEW_TAB_URL } from '@shared/types/tab'
import type { IpcRegistry } from '../ipc/registry'
import type { SessionRegistry } from '../sessions/SessionRegistry'
import type { HistoryRepository } from '../db/repositories/HistoryRepository'
import type { WorkspaceRepository } from '../db/repositories/WorkspaceRepository'
import type { SettingsStore } from '../settings/SettingsStore'
import { TabManager } from '../tabs/TabManager'
import { TabPerformanceManager } from '../performance/TabPerformanceManager'
import { createLogger } from '../logger'
import { OverlayController } from './OverlayController'
import { ViewLayoutManager } from './ViewLayoutManager'
import { rendererEntry } from './rendererEntry'

const log = createLogger('window')

export interface WindowDeps {
  ipc: IpcRegistry
  sessions: SessionRegistry
  history: HistoryRepository
  workspaces: WorkspaceRepository
  settings: SettingsStore
  /** Narrow view of DownloadManager, for the performance engine's guard. */
  downloads: { hasActiveDownloadFrom: (webContentsId: number) => boolean }
}

/**
 * One browser window and its stack of native views.
 *
 * Z-order, bottom to top — child index order in `contentView`:
 *
 *   0. chrome  — the React UI, spanning the full content area
 *   1. page    — the active tab's web content, inset into the chrome's content hole
 *   2. overlay — transparent, added on demand, always topmost
 *
 * `TabManager` owns slot 1 and swaps which view occupies it. When the active tab
 * is an internal page (the new tab page) or hibernated, slot 1 is simply empty
 * and the chrome document shows through — which is why the new tab page needs
 * neither a custom protocol nor a renderer of its own.
 */
export class BrowserWindowController {
  private readonly window: BaseWindow
  private readonly layout = new ViewLayoutManager()
  private readonly chromeView: WebContentsView
  readonly overlay: OverlayController
  readonly tabs: TabManager
  readonly performance: TabPerformanceManager

  constructor(private readonly deps: WindowDeps) {
    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 400,
      show: false,
      backgroundColor: '#0b0d12',
      title: 'Adaptive Browser'
    })

    this.chromeView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/chrome.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })

    this.window.contentView.addChildView(this.chromeView)
    this.deps.ipc.registerPrivilegedView(this.chromeView.webContents, VIEW_KIND.chrome)
    this.hardenChrome(this.chromeView.webContents)

    const entry = rendererEntry('index')
    if (entry.kind === 'url') void this.chromeView.webContents.loadURL(entry.url)
    else void this.chromeView.webContents.loadFile(entry.path)

    this.overlay = new OverlayController(this.window, this.deps.ipc)

    this.tabs = new TabManager(
      this.window,
      {
        // A workspace's session is resolved through the registry, which is what
        // guarantees a newly created `persist:ws-*` partition is hardened before
        // any page loads in it.
        sessionFor: (workspaceId) =>
          this.deps.sessions.getForWorkspace(
            workspaceId,
            this.deps.workspaces.findById(workspaceId)?.isolated ?? false
          ),
        isIsolated: (workspaceId) =>
          this.deps.workspaces.findById(workspaceId)?.isolated ?? false
      },
      {
        onSnapshot: (snapshot) => {
          this.deps.ipc.broadcast('tabs:snapshot', snapshot, this.privilegedContents())
        },
        onNavigated: (url, title, faviconUrl) => {
          if (!this.deps.settings.getAll().recordHistory) return
          this.deps.history.recordVisit(url, title, faviconUrl)
          this.deps.ipc.broadcast('history:changed', {}, this.privilegedContents())
        },
        onMetadata: (url, title, faviconUrl) => {
          if (!this.deps.settings.getAll().recordHistory) return
          this.deps.history.updateMetadata(url, title, faviconUrl)
        }
      }
    )

    this.performance = new TabPerformanceManager(this.tabs, {
      onSnapshot: (snapshot) => {
        this.deps.ipc.broadcast('performance:changed', snapshot, this.privilegedContents())
      },
      hasActiveDownload: (tabId) => {
        const contents = this.tabs.findById(tabId)?.contents
        return contents ? this.deps.downloads.hasActiveDownloadFrom(contents.id) : false
      }
    })
    this.performance.policy.setMode(this.deps.settings.getAll().performanceMode)
    this.performance.start()

    // The workspace rail is always visible in Phase 2, so the page view is
    // permanently inset by its width. Both sides read the same constant.
    this.layout.setSidebarWidth(WORKSPACE_RAIL_WIDTH)

    this.window.on('resize', () => this.applyLayout())
    this.applyLayout()

    this.chromeView.webContents.once('did-finish-load', () => {
      // Open the first tab only once the chrome can receive the snapshot, so the
      // strip is never briefly empty.
      this.tabs.create({ url: NEW_TAB_URL })
      this.window.show()
      log.info('window shown')
    })
  }

  /**
   * The chrome view holds privileged IPC. It must never be navigable away from
   * its own document — otherwise a bug that routes a link here would hand a
   * remote origin the `window.browser` bridge.
   */
  private hardenChrome(contents: WebContents): void {
    contents.on('will-navigate', (event, url) => {
      const devServer = process.env['ELECTRON_RENDERER_URL']
      if ((devServer && url.startsWith(devServer)) || url.startsWith('file://')) return
      event.preventDefault()
      log.error(`blocked navigation of the chrome view to ${url}`)
    })

    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  /** Reserves space on the right for a side panel and re-lays out the views. */
  setRightPanelWidth(width: number): void {
    this.layout.setRightPanelWidth(width)
    this.applyLayout()
  }

  private applyLayout(): void {
    const { width, height } = this.window.getContentBounds()
    const rects = this.layout.compute(width, height)
    this.chromeView.setBounds(rects.chrome)
    this.tabs.setPageBounds(rects.page)
    this.overlay.relayout(rects.full)
  }

  /** Full content rect, for modal overlay surfaces. */
  fullBounds() {
    const { width, height } = this.window.getContentBounds()
    return this.layout.compute(width, height).full
  }

  /** Privileged views only — the broadcast targets for main→renderer events. */
  privilegedContents(): WebContents[] {
    const targets: WebContents[] = []
    if (!this.chromeView.webContents.isDestroyed()) targets.push(this.chromeView.webContents)
    const overlayContents = this.overlay.webContents
    if (overlayContents && !overlayContents.isDestroyed()) targets.push(overlayContents)
    return targets
  }

  get browserWindow(): BaseWindow {
    return this.window
  }

  get isFocused(): boolean {
    return !this.window.isDestroyed() && this.window.isFocused()
  }

  destroy(): void {
    this.performance.stop()
    this.overlay.destroy()
    this.tabs.destroy()
    if (!this.chromeView.webContents.isDestroyed()) this.chromeView.webContents.close()
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}
