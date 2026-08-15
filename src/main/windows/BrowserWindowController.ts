import { join } from 'node:path'
import { BaseWindow, WebContentsView, shell, dialog, type WebContents } from 'electron'
import { VIEW_KIND, WORKSPACE_RAIL_WIDTH, TITLE_BAR_HEIGHT } from '@shared/constants'
import { appIconPath } from './appIcon'
import { NEW_TAB_URL } from '@shared/types/tab'
import type { OmniboxState } from '@shared/types/omnibox'
import type { PermissionRequest } from '@shared/types/permission'
import type { IpcRegistry } from '../ipc/registry'
import type { SessionRegistry } from '../sessions/SessionRegistry'
import type { HistoryRepository } from '../db/repositories/HistoryRepository'
import type { WorkspaceRepository } from '../db/repositories/WorkspaceRepository'
import type { SettingsStore } from '../settings/SettingsStore'
import { TabManager } from '../tabs/TabManager'
import { TabPerformanceManager } from '../performance/TabPerformanceManager'
import { installPageContextMenu, type ContextMenuDeps } from '../menus/ContextMenus'
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
  /** Invoked by the tab context menu's "Bookmark this tab". */
  onBookmarkRequested: (url: string, title: string) => void
  /** A tab closed — drop anything scoped to it. */
  onTabDiscarded: (tabId: string) => void
  /** A page finished loading; the Web Memory indexer decides what to do with it. */
  onPageLoaded: (contents: WebContents, url: string) => void
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
  /**
   * Last published omnibox dropdown state.
   *
   * Held here so the overlay document can pull it on mount — see the
   * `omnibox:getState` contract for why a push alone is not enough.
   */
  omniboxState: OmniboxState | null = null
  /** Prompt currently on screen, pulled by the overlay when it mounts. */
  pendingPermission: PermissionRequest | null = null

  constructor(private readonly deps: WindowDeps) {
    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 400,
      show: false,
      backgroundColor: '#0b0d12',
      title: 'Adaptive Browser',
      icon: appIconPath(),

      // No OS title bar: the tab strip is the title bar, as in every mainstream
      // browser. Windows still draws the minimise/maximise/close buttons itself
      // through the overlay, so they behave exactly like a native window's —
      // including snap layouts on hover — rather than being HTML imitations.
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0b0d12',
        symbolColor: '#98a1b3',
        height: TITLE_BAR_HEIGHT
      },
      // The menu is kept for its accelerators but its bar stays hidden until Alt,
      // which is how Firefox behaves. A permanent File/Edit/View bar is the most
      // obvious sign of a desktop app that is not a browser.
      autoHideMenuBar: true
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

    // Surface renderer errors in the main log. A React exception in the chrome
    // document blanks the entire UI while the window frame stays up, which looks
    // like a compositing failure and is otherwise invisible without devtools.
    this.chromeView.webContents.on('console-message', (event) => {
      if (event.level === 'error') log.error(`chrome console: ${event.message}`)
    })
    this.chromeView.webContents.on('render-process-gone', (_e, details) => {
      log.error(`chrome renderer gone: ${details.reason}`)
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
          this.syncWindowTitle(snapshot)
        },
        onNavigated: (url, title, faviconUrl) => {
          if (!this.deps.settings.getAll().recordHistory) return
          this.deps.history.recordVisit(url, title, faviconUrl)
          this.deps.ipc.broadcast('history:changed', {}, this.privilegedContents())
        },
        onMetadata: (url, title, faviconUrl) => {
          if (!this.deps.settings.getAll().recordHistory) return
          this.deps.history.updateMetadata(url, title, faviconUrl)
        },
        installPageContextMenu: (contents) =>
          installPageContextMenu(contents, this.contextMenuDeps()),
        onTabDiscarded: (tabId) => this.deps.onTabDiscarded(tabId),
        onPageLoaded: (tab, url) => {
          const contents = tab.contents
          if (contents) void this.deps.onPageLoaded(contents, url)
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

  /**
   * Dependencies the context menus need. Built lazily so the menu always
   * reflects current workspaces and settings rather than a snapshot from
   * construction time.
   */
  contextMenuDeps(): ContextMenuDeps {
    return {
      tabs: this.tabs,
      window: this.window,
      workspaces: this.deps.workspaces,
      searchEngineId: () => this.deps.settings.getAll().searchEngineId,
      bookmarkUrl: (url, title) => this.deps.onBookmarkRequested(url, title),
      moveTabToWorkspace: (tabId, workspaceId) => {
        const from = this.tabs.findById(tabId)?.snapshot.workspaceId
        const target = this.deps.workspaces.findById(workspaceId)
        const source = from ? this.deps.workspaces.findById(from) : null
        const crosses = (target?.isolated ?? false) || (source?.isolated ?? false)

        // The same warning the drag path gives: the target workspace has its own
        // cookie partition, so the page reloads signed out and nothing can carry
        // the session across.
        if (crosses) {
          const choice = dialog.showMessageBoxSync(this.window, {
            type: 'question',
            buttons: ['Move', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Move tab to another workspace?',
            message: `Move this tab to "${target?.name}"?`,
            detail:
              'That workspace keeps its own cookies and storage, so the page will reload and ' +
              'you will be signed out of it there. Anything unsaved on the page will be lost.',
            noLink: true
          })
          if (choice !== 0) return
        }
        this.tabs.moveToWorkspace(tabId, workspaceId)
        this.tabs.emitNow()
      }
    }
  }

  /**
   * Keeps the window title on the active tab, the way a browser does.
   *
   * It shows in the taskbar preview and in Alt+Tab, so a static "Adaptive
   * Browser" there is a small but constant reminder that this is an app window
   * rather than a browser.
   */
  private syncWindowTitle(snapshot: { tabs: { id: string; title: string; url: string }[]; activeTabId: string | null }): void {
    if (this.window.isDestroyed()) return
    const active = snapshot.tabs.find((t) => t.id === snapshot.activeTabId)
    const label = active?.title?.trim()
    this.window.setTitle(label ? `${label} — Adaptive Browser` : 'Adaptive Browser')
  }

  /** Reserves space on the right for a side panel and re-lays out the views. */
  setRightPanelWidth(width: number): void {
    this.layout.setRightPanelWidth(width)
    this.applyLayout()
  }

  /**
   * Shows a permission prompt over the page.
   *
   * Modal and full-bounds on purpose: a permission decision should not be
   * dismissible by clicking past it onto the page that asked.
   */
  showPermissionPrompt(request: PermissionRequest): void {
    this.pendingPermission = request
    const state = this.overlay.show('permission-prompt', this.fullBounds(), {
      modal: true,
      takeFocus: true
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
    this.deps.ipc.broadcast('permissions:prompt', request, this.privilegedContents())
  }

  dismissPermissionPrompt(requestId: string): void {
    if (this.pendingPermission?.requestId !== requestId) return
    this.pendingPermission = null
    const state = this.overlay.hide()
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
    this.deps.ipc.broadcast('permissions:prompt', null, this.privilegedContents())
  }

  /** Chrome grew or shrank — e.g. the find bar opened. */
  setChromeHeight(height: number): void {
    this.layout.setChromeHeight(height)
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
