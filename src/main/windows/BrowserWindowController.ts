import { join } from 'node:path'
import { BaseWindow, WebContentsView, shell, dialog, type WebContents } from 'electron'
import {
  VIEW_KIND,
  WORKSPACE_RAIL_WIDTH,
  VERTICAL_TAB_STRIP_WIDTH,
  TITLE_BAR_HEIGHT,
  PAGE_INSET
} from '@shared/constants'
import { appIconPath } from './appIcon'
import { NEW_TAB_URL } from '@shared/types/tab'
import type { OmniboxState } from '@shared/types/omnibox'
import type { PermissionRequest } from '@shared/types/permission'
import type { ReaderResult } from '@shared/types/reader'
import type { RedirectChain } from '@shared/types/redirectChain'
import { RedirectRecorder } from '../shield/RedirectRecorder'
import type { IpcRegistry } from '../ipc/registry'
import type { SessionRegistry } from '../sessions/SessionRegistry'
import type { HistoryRepository } from '../db/repositories/HistoryRepository'
import type { WorkspaceRepository } from '../db/repositories/WorkspaceRepository'
import type { SettingsStore } from '../settings/SettingsStore'
import { TabManager, type ClosedTab as ClosedTabEntry } from '../tabs/TabManager'
import { TabPerformanceManager } from '../performance/TabPerformanceManager'
import { installPageContextMenu, type ContextMenuDeps } from '../menus/ContextMenus'
import { createLogger } from '../logger'
import { OverlayController } from './OverlayController'
import { ViewLayoutManager } from './ViewLayoutManager'
import { rendererEntry } from './rendererEntry'

const log = createLogger('window')

export interface WindowDeps {
  /**
   * A private window: in-memory session, nothing written to history or memory.
   *
   * Fixed at construction and never toggled. Flipping it later would strand
   * whatever the window had already recorded — the same reasoning that makes
   * workspace isolation immutable.
   */
  isPrivate?: boolean
  ipc: IpcRegistry
  sessions: SessionRegistry
  history: HistoryRepository
  workspaces: WorkspaceRepository
  settings: SettingsStore
  /** Narrow view of DownloadManager, for the performance engine's guard. */
  downloads: { hasActiveDownloadFrom: (webContentsId: number) => boolean }
  /** Invoked by the tab context menu's "Bookmark this tab". */
  onBookmarkRequested: (url: string, title: string) => void
  /** Hands a link to the segmented download engine, from the link context menu. */
  enqueueDownload?: (url: string) => void
  /** Installs the YouTube ad-break filter on a new page view. */
  observeYouTube?: (contents: WebContents) => void
  /** Shield's known ad/tracking host list, for classifying redirect chains. */
  isKnownAdHost?: (host: string) => boolean
  /** A redirect chain finished and is worth reporting to the user. */
  onRedirectChain?: (chain: RedirectChain) => void
  /** A tab closed — drop anything scoped to it. */
  onTabDiscarded: (tabId: string) => void
  /** A tab closed — persisted so reopening it survives a restart. */
  onTabClosed: (entry: ClosedTabEntry & { closedAt: number }) => void
  /** The most recent persisted closed tab, consumed by reopen. */
  takeClosedTab: () => ClosedTabEntry | null
  /** A page finished loading; the Web Memory indexer decides what to do with it. */
  onPageLoaded: (contents: WebContents, url: string) => void
  /** Slash Shield's verdict on a `window.open` from a page in this window. */
  shouldAllowPopup: (tabId: string, url: string, pageUrl: string, webContentsId: number) => boolean
  /** Slash Shield's verdict on a page-initiated top-level navigation. */
  shouldAllowNavigation: (
    tabId: string,
    url: string,
    pageUrl: string,
    webContentsId: number
  ) => boolean
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
  /** Redirect X-Ray's record of main-frame chains in this window. */
  readonly redirectRecorder: RedirectRecorder
  readonly tabs: TabManager
  readonly performance: TabPerformanceManager
  /**
   * Last published omnibox dropdown state.
   *
   * Held here so the overlay document can pull it on mount — see the
   * `omnibox:getState` contract for why a push alone is not enough.
   */
  omniboxState: OmniboxState | null = null
  /** Whether this window browses privately. Fixed at construction. */
  get isPrivate(): boolean {
    return this.depsIsPrivate
  }
  /** Prompt currently on screen, pulled by the overlay when it mounts. */
  pendingPermission: PermissionRequest | null = null

  /** Read before `this.deps` is assignable inside the constructor's super call. */
  private readonly depsIsPrivate: boolean

  constructor(private readonly deps: WindowDeps) {
    this.depsIsPrivate = deps.isPrivate === true
    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 400,
      show: false,
      // Fully transparent so Windows' own acrylic shows through. A solid colour
      // here would sit on top of the material and defeat it entirely.
      backgroundColor: '#00000000',
      /**
       * Real blur, composited by the OS.
       *
       * `acrylic` samples what is behind the window, which CSS `backdrop-filter`
       * cannot do — that only blurs what is inside the same document. The chrome
       * is translucent over it; page content stays opaque, because a readable
       * web page matters more than seeing the desktop through it.
       *
       * Windows 11 only. On 10 it is ignored and the painted background shows,
       * which is why every surface still defines its own colour.
       */
      backgroundMaterial: 'acrylic',
      title: this.depsIsPrivate ? 'Slash — Private' : 'Slash',
      icon: appIconPath(),

      // No OS title bar: the tab strip is the title bar, as in every mainstream
      // browser. Windows still draws the minimise/maximise/close buttons itself
      // through the overlay, so they behave exactly like a native window's —
      // including snap layouts on hover — rather than being HTML imitations.
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        // Transparent, so the window-control strip sits on the same glass as the
        // tabs beside it rather than as an opaque block in the corner.
        color: '#00000000',
        symbolColor: '#c8cede',
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
        webSecurity: true,
        // Required for the window's acrylic to be visible through the chrome.
        // Without it Chromium paints an opaque base layer over the material.
        transparent: true
      }
    })
    this.chromeView.setBackgroundColor('#00000000')

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

    // Constructed before TabManager, which hands it every new page view.
    this.redirectRecorder = new RedirectRecorder(
      (host) => this.deps.isKnownAdHost?.(host) ?? false,
      (chain) => this.deps.onRedirectChain?.(chain)
    )

    this.tabs = new TabManager(
      this.window,
      {
        // A workspace's session is resolved through the registry, which is what
        // guarantees a newly created `persist:ws-*` partition is hardened before
        // any page loads in it.
        // A private window ignores workspace isolation entirely: every tab in it
        // shares the one in-memory partition, so nothing it does can reach a
        // persisted cookie jar.
        sessionFor: (workspaceId) =>
          this.deps.isPrivate === true
            ? this.deps.sessions.getPrivate()
            : this.deps.sessions.getForWorkspace(
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
          // A private window writes no history, regardless of the setting. This
          // is the guarantee the window's whole existence rests on, so it is
          // checked here rather than left to the indexer downstream.
          if (this.depsIsPrivate) return
          if (!this.deps.settings.getAll().recordHistory) return
          this.deps.history.recordVisit(url, title, faviconUrl)
          this.deps.ipc.broadcast('history:changed', {}, this.privilegedContents())
        },
        onMetadata: (url, title, faviconUrl) => {
          if (this.depsIsPrivate) return
          if (!this.deps.settings.getAll().recordHistory) return
          this.deps.history.updateMetadata(url, title, faviconUrl)
        },
        observeRedirects: (tabId, contents) => {
          this.redirectRecorder.attachToTab(tabId, contents)
          this.deps.observeYouTube?.(contents)
        },
        installPageContextMenu: (contents) =>
          installPageContextMenu(contents, this.contextMenuDeps()),
        onTabDiscarded: (tabId) => this.deps.onTabDiscarded(tabId),
        onTabClosed: (entry) => this.deps.onTabClosed(entry),
        takeClosedTab: () => this.deps.takeClosedTab(),
        shouldAllowPopup: (tab, url, webContentsId) =>
          this.deps.shouldAllowPopup(tab.id, url, tab.snapshot.url, webContentsId),
        shouldAllowNavigation: (tab, url, webContentsId) =>
          this.deps.shouldAllowNavigation(tab.id, url, tab.snapshot.url, webContentsId),
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

    // The workspace rail is always visible, so the page view is permanently
    // inset by its width; a vertical tab strip sits beside it and widens the
    // same inset. Both sides read the same constants.
    this.applySidebarWidth()
    // Leaves a gutter of glass around the page, so the chrome frames it rather
    // than the page covering every pixel below the toolbar.
    this.layout.setPageInset(PAGE_INSET)

    this.window.on('resize', () => this.applyLayout())
    this.applyLayout()

    this.chromeView.webContents.once('did-finish-load', () => {
      // Open the first tab only once the chrome can receive the snapshot, so the
      // strip is never briefly empty.
      //
      // Only when the window is genuinely empty. Session restore runs while this
      // document is still loading, so an unconditional create added a blank tab
      // *after* the restored ones and activated it — every launch with a restored
      // session landed on an empty new tab with a stray extra tab in the strip.
      if (this.tabs.allTabs().length === 0) {
        this.tabs.create({ url: NEW_TAB_URL })
      } else {
        // Push the restored state now that the chrome can receive it.
        this.tabs.emitNow()
      }
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
      enqueueDownload: (url) => this.deps.enqueueDownload?.(url),
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
    this.window.setTitle(label ? `${label} — Slash` : 'Slash')
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

  /**
   * Opens tab search over the page.
   *
   * Modal and focused: it is a picker the user just asked for, and it has a text
   * field that must receive their next keystroke. Driven from the menu, so it
   * works regardless of whether focus was in the page or the chrome — a renderer
   * keydown handler would never see Ctrl+Shift+A while a web page had focus.
   */
  showTabSearch(): void {
    const state = this.overlay.show('tab-search', this.fullBounds(), {
      modal: true,
      takeFocus: true
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /**
   * Holds the extracted article between `reader:open` and the overlay mounting.
   *
   * The overlay document loads asynchronously after `show()`, so it cannot be
   * handed the article directly — it pulls it once it is alive, the same race
   * the permission prompt and the omnibox dropdown already solve this way.
   */
  pendingReader: ReaderResult | null = null

  showReader(result: ReaderResult): void {
    this.pendingReader = result
    const state = this.overlay.show('reader', this.fullBounds(), {
      modal: true,
      takeFocus: true
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  dismissPermissionPrompt(requestId: string): void {
    if (this.pendingPermission?.requestId !== requestId) return
    this.pendingPermission = null
    const state = this.overlay.hide()
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
    this.deps.ipc.broadcast('permissions:prompt', null, this.privilegedContents())
  }

  /**
   * Re-insets the page for the current tab-strip position.
   *
   * Called at construction and whenever the setting changes. The native page
   * view knows nothing about our CSS, so moving the strip in React without this
   * would draw the tab column *underneath* the page — the same trap that makes
   * side panels inset rather than float.
   */
  applySidebarWidth(): void {
    const vertical = this.deps.settings.getAll().tabStripPosition === 'left'
    this.layout.setSidebarWidth(WORKSPACE_RAIL_WIDTH + (vertical ? VERTICAL_TAB_STRIP_WIDTH : 0))
    this.applyLayout()
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
