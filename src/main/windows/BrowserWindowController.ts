import { join } from 'node:path'
import type { SponsoredTile } from '@shared/types/sponsor'
import type { InvokeResponse } from '@shared/ipc/contracts'
import { BaseWindow, WebContentsView, screen, shell, dialog, type WebContents } from 'electron'
import {
  VIEW_KIND,
  VERTICAL_TAB_STRIP_WIDTH,
  TITLE_BAR_HEIGHT,
  PAGE_INSET
} from '@shared/constants'
import { appIconPath } from './appIcon'
import { NEW_TAB_URL } from '@shared/types/tab'

/** The one file the floating chip offers. Mirrors the media:offer response. */
export type MediaOffer = NonNullable<InvokeResponse<'media:offer'>>
import type { OmniboxState } from '@shared/types/omnibox'
import type { PermissionRequest } from '@shared/types/permission'
import type { TabGroup } from '@shared/types/tabGroup'
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
import { installChromeContextMenu } from '../menus/ChromeContextMenu'
import { resolveInput } from '../navigation/UrlResolver'
import { createLogger } from '../logger'
import { OverlayController } from './OverlayController'
import { ViewLayoutManager } from './ViewLayoutManager'
import { rendererEntry } from './rendererEntry'
import { describeMachine, effectiveMode } from '@shared/hardwareProfile'
import { readMachine } from '../performance/readMachine'

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
  enqueueDownload?: (url: string, contents: WebContents | null) => void
  /** Saved addresses that could fill the page this context menu opened over. */
  addressOffers?: (contents: WebContents) => { id: number; label: string }[]
  fillAddress?: (contents: WebContents, id: number) => void
  /** Installs the YouTube ad-break filter on a new page view. */
  observeYouTube?: (contents: WebContents) => void
  shieldReady?: (contents: WebContents) => Promise<void>
  shieldNeededFor?: (url: string) => boolean
  /** Follows a new page view's navigations for media detection. */
  observeMedia?: (contents: WebContents) => void
  /**
   * What the floating download chip should offer for this window, if anything.
   *
   * Injected rather than reached for, because the sniffer is application-wide
   * and the window must not know about it — the window knows only that
   * something may want to float over its page.
   */
  mediaOffer?: (window: BrowserWindowController) => MediaOffer | null
  /** Shield's known ad/tracking host list, for classifying redirect chains. */
  isKnownAdHost?: (host: string) => boolean
  /** A redirect chain finished and is worth reporting to the user. */
  onRedirectChain?: (chain: RedirectChain) => void
  /** A tab closed — drop anything scoped to it. */
  /**
   * The set of open tabs changed.
   *
   * Distinct from `onSnapshot`, which fires for anything the UI renders —
   * a title, a favicon, a loading spinner. This is for changes worth writing
   * to disk.
   */
  onTabsChanged?: () => void
  onTabDiscarded: (tabId: string) => void
  /** A tab closed — persisted so reopening it survives a restart. */
  onTabClosed: (entry: ClosedTabEntry & { closedAt: number }) => void
  /** The most recent persisted closed tab, consumed by reopen. */
  takeClosedTab: () => ClosedTabEntry | null
  /** Every persisted closed tab, for a caller that offers a choice of them. */
  listClosedTabs: () => (ClosedTabEntry & { id: number; closedAt: number })[]
  /** One particular persisted closed tab, consumed by reopening from a list. */
  takeClosedTabAt: (id: number) => ClosedTabEntry | null
  /** Tab groups changed — persisted so an arrangement survives a restart. */
  onGroupsChanged?: (groups: readonly TabGroup[]) => void
  /** A tab was hibernated, with the bytes actually released, or null. */
  onHibernated?: (bytesFreed: number | null) => void
  /** Remembered zoom for a URL's host, or null at the default. */
  siteZoomFor?: (url: string) => number | null
  /** The user changed zoom on this host; remember it for next time. */
  onSiteZoomChanged?: (url: string, level: number) => void
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
/**
 * How close to the top edge counts as "the pointer came back".
 *
 * Wider than the OS resize border it has to see through, because the gesture is
 * a flick to the top of the window and the pointer lands within a pixel or two
 * of the edge.
 */
const CHROME_REVEAL_BAND = 8

/**
 * Cursor poll while - and only while - auto-hide has the chrome collapsed.
 *
 * Fast enough that the bars feel like they were waiting, slow enough to be
 * nothing: `getCursorScreenPoint` is a synchronous read of a value the OS
 * already holds.
 */
const CHROME_REVEAL_POLL_MS = 90

/**
 * How far below the chrome the pointer must go before the bars retreat.
 *
 * Hysteresis. Revealing triggers on the top few pixels and hiding on this,
 * which is much further down - with a single threshold the pointer resting near
 * the boundary flips the state on every poll and the chrome strobes.
 */
const CHROME_HIDE_MARGIN = 56

/** How long the page takes to slide to a new inset. */
const CHROME_TWEEN_MS = 260

/** How long the window takes to fade up on launch. */
const WINDOW_FADE_MS = 260

export class BrowserWindowController {
  private readonly window: BaseWindow
  private readonly layout = new ViewLayoutManager()
  private chromeRevealTimer: ReturnType<typeof setInterval> | null = null
  private chromeIsHidden = false
  private chromeTween: ReturnType<typeof setInterval> | null = null
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

    /*
     * Whether this window trades the glass for sharp text.
     *
     * Read once, here, because `transparent` is fixed when a view is
     * constructed — there is no way to change it on a live window, which is why
     * the setting's copy asks for a new window rather than appearing to do
     * nothing.
     */
    const sharpText = deps.settings.getAll().sharpText

    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 400,
      show: false,
      // Fully transparent so Windows' own acrylic shows through. A solid colour
      // here would sit on top of the material and defeat it entirely — which is
      // exactly what `sharpText` wants, so it paints one.
      backgroundColor: sharpText ? '#0d0f14' : '#00000000',
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
      // Acrylic needs something translucent in front of it to be seen through.
      // With a solid chrome there is nothing to see, so asking for it would buy
      // a composited layer and no visible effect.
      ...(sharpText ? {} : { backgroundMaterial: 'acrylic' as const }),
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
        /*
         * Transparent so the window's acrylic is visible through the chrome —
         * and **this is what makes the app's own text look soft**. Chromium has
         * no opaque backing to blend subpixels against, so every label in the
         * browser falls back to grayscale antialiasing, which is the difference
         * people see against Chrome on the same monitor.
         *
         * `sharpText` trades the glass for that.
         */
        transparent: !sharpText
      }
    })
    this.chromeView.setBackgroundColor(sharpText ? '#0d0f14' : '#00000000')

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
    // Slash's own interface had no right-click menu at all, so the address bar
    // could not be copied out of or pasted into with the mouse. Deliberately a
    // much smaller menu than a page's — this document holds the privileged IPC
    // bridge, so it gets editing commands and nothing else.
    installChromeContextMenu(this.chromeView.webContents, {
      window: this.window,
      navigate: (input) => {
        const tabId = this.tabs.activeTab?.id
        if (!tabId) return
        // Resolved through the same function the omnibox uses, so pasting a
        // search term does a search rather than being treated as an address.
        const settings = this.deps.settings.getAll()
        const resolved = resolveInput(
          input,
          settings.searchEngineId,
          settings.customSearchEngines
        )
        this.tabs.navigate(tabId, resolved.url)
      }
    })

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
          // Records the session a few seconds after it settles, so a force-kill
          // loses seconds rather than up to five minutes. Debounced inside.
          this.deps.onTabsChanged?.()
          // Switching tabs changes what is playing. `refreshMediaOffer` is
          // idempotent, so calling it from the snapshot costs a comparison.
          this.refreshMediaOffer()
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
          this.observePageFullscreen(contents)
        },
        shieldReady: (contents) => this.deps.shieldReady?.(contents) ?? Promise.resolve(),
        shieldNeededFor: (url) => this.deps.shieldNeededFor?.(url) ?? false,
        observeMedia: (contents) => this.deps.observeMedia?.(contents),
        installPageContextMenu: (contents) =>
          installPageContextMenu(contents, this.contextMenuDeps()),
        onTabDiscarded: (tabId) => this.deps.onTabDiscarded(tabId),
        onTabClosed: (entry) => this.deps.onTabClosed(entry),
        takeClosedTab: () => this.deps.takeClosedTab(),
        listClosedTabs: () => this.deps.listClosedTabs(),
        takeClosedTabAt: (id) => this.deps.takeClosedTabAt(id),
        onHibernated: (bytesFreed) => this.deps.onHibernated?.(bytesFreed),
        onGroupsChanged: (groups) => this.deps.onGroupsChanged?.(groups),
        siteZoomFor: (url) => this.deps.siteZoomFor?.(url) ?? null,
        onSiteZoomChanged: (url, level) => this.deps.onSiteZoomChanged?.(url, level),
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
    // The stored mode, adjusted for what this machine actually is. See
    // `effectiveMode`: an explicit "off" is never overruled.
    const settings = this.deps.settings.getAll()
    this.performance.policy.setMode(
      effectiveMode(
        settings.performanceMode,
        describeMachine(readMachine()),
        settings.hardwareOptimisation
      )
    )
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
      this.revealWindow()
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
      // The active tab is the page the menu was opened on, and it is the
      // referrer the download has to carry — a "Download with Slash" that drops
      // it is refused by every host that checks.
      enqueueDownload: (url) => this.deps.enqueueDownload?.(url, this.tabs.activeTab?.contents ?? null),
      addressOffers: (contents) => this.deps.addressOffers?.(contents) ?? [],
      fillAddress: (contents, id) => this.deps.fillAddress?.(contents, id),
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
   * Opens the keyboard-shortcut sheet.
   *
   * Not focused: it is a reference card, and stealing focus from whatever the
   * user was doing to show them a list of keys would be its own small joke.
   */
  showShortcuts(): void {
    const state = this.overlay.show('shortcuts', this.fullBounds(), {
      modal: true,
      takeFocus: false
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /**
   * Opens the command palette.
   *
   * Modal and focused: it is a text field the user just summoned and their next
   * keystroke belongs to it. Driven from the menu like every other accelerator,
   * because focus normally sits in a web page and a renderer keydown handler
   * would never see Ctrl+K.
   */
  showCommandPalette(): void {
    const state = this.overlay.show('command-palette', this.fullBounds(), {
      modal: true,
      takeFocus: true
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /**
   * Opens the list of saved sign-ins that match this page.
   *
   * In the overlay rather than as a toolbar dropdown, for the reason the shield
   * panel learned the hard way: a native page view composites above the chrome
   * document, so a dropdown extending over the page is simply not drawn.
   */
  showPasswordFill(): void {
    const state = this.overlay.show('passwords', this.fullBounds(), {
      modal: true,
      takeFocus: false
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /**
   * Opens the first-run walkthrough.
   *
   * Modal, and in the overlay rather than the chrome: a restored session puts a
   * real page view in the content hole, and a native view composites above the
   * DOM. Not focused, so it cannot steal a keystroke from someone who started
   * typing an address before it appeared.
   */
  showOnboarding(): void {
    const state = this.overlay.show('onboarding', this.fullBounds(), {
      modal: true,
      takeFocus: false
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /**
   * Puts an available update in front of the user.
   *
   * Modal and focused, unlike onboarding: this one is a question with two
   * answers and the buttons are the only way out, so the keyboard should reach
   * them. Full bounds because it is deliberately not dismissable by clicking
   * past it -- an overlay swallows clicks inside its own rect, and here that
   * property is the feature rather than a cost to work around.
   */
  showUpdateRequired(): void {
    const state = this.overlay.show('update-required', this.fullBounds(), {
      modal: true,
      takeFocus: true
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
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
    // No workspace rail any more — it is a row at the top of the chrome, so
    // the only thing that still insets the page from the left is the vertical
    // tab column, and a horizontal strip insets nothing at all.
    this.layout.setSidebarWidth(vertical ? VERTICAL_TAB_STRIP_WIDTH : 0)
    this.applyLayout()
  }

  /**
   * Shows the window by fading it up rather than making it appear.
   *
   * Costs nothing: the window is created transparent and this runs at exactly
   * the moment `show()` used to, on the chrome view's `did-finish-load`. The
   * browser is already interactive underneath — the renderer's own launch
   * sequence plays over live chrome — so this is a reveal, not a splash screen
   * standing between somebody and their tabs.
   *
   * Same cubic ease-out and the same stepped tween as `setChromeHeight`, rather
   * than a second easing implementation that could drift from it.
   */
  private revealWindow(): void {
    this.window.setOpacity(0)
    this.window.show()

    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (this.window.isDestroyed()) return clearInterval(timer)
      const progress = Math.min(1, (Date.now() - startedAt) / WINDOW_FADE_MS)
      this.window.setOpacity(1 - Math.pow(1 - progress, 3))
      if (progress >= 1) {
        clearInterval(timer)
        // Set to exactly 1 rather than to a rounding of it: a window left at
        // 0.999 opacity is composited as translucent for the rest of its life.
        this.window.setOpacity(1)
      }
    }, 16)
    log.info(`window shown (fading up over ${WINDOW_FADE_MS}ms)`)
  }

  /**
   * Chrome grew or shrank — the find bar opened, or auto-hide moved.
   *
   * Tweened rather than set, because the page is a **native view** and the
   * chrome document is not. Animating the CSS rows alone made the bars fade in
   * over a page that had already jumped 124px down to meet them, which reads
   * worse than no animation at all. Both have to move together, so the inset is
   * stepped here while the rows transition over the same duration.
   *
   * A step is one `setBounds` on a view Chromium is already compositing, and
   * only while a transition is running - not a frame loop the browser pays for
   * at rest.
   */
  setChromeHeight(height: number): void {
    const from = this.layout.chromeHeightPx
    const to = Math.max(0, Math.round(height))
    if (this.chromeTween) {
      clearInterval(this.chromeTween)
      this.chromeTween = null
    }
    if (from === to) return

    // A big move is a reveal or a hide and wants the animation; a small one is
    // a notice bar appearing, where a tween would just look sluggish.
    if (Math.abs(to - from) < 24) {
      this.layout.setChromeHeight(to)
      this.applyLayout()
      return
    }

    const startedAt = Date.now()
    this.chromeTween = setInterval(() => {
      if (this.window.isDestroyed()) {
        if (this.chromeTween) clearInterval(this.chromeTween)
        this.chromeTween = null
        return
      }
      const elapsed = Date.now() - startedAt
      const progress = Math.min(1, elapsed / CHROME_TWEEN_MS)
      // Cubic ease-out: quick to leave, gentle to arrive, which is what makes
      // it read as deliberate rather than as lag.
      const eased = 1 - Math.pow(1 - progress, 3)
      this.layout.setChromeHeight(Math.round(from + (to - from) * eased))
      this.applyLayout()

      if (progress >= 1 && this.chromeTween) {
        clearInterval(this.chromeTween)
        this.chromeTween = null
      }
    }, 16)
  }

  /**
   * Watches for the pointer returning to the top edge while auto-hide has the
   * chrome collapsed.
   *
   * This has to live in main, and the reason is the one part of auto-hide that
   * is not obvious. The natural implementation is a few pixels of real chrome
   * left at the top with a `mouseenter` on it — and it cannot work here. The
   * window is `titleBarStyle: 'hidden'`, which keeps the **native** frame, so
   * the outermost pixels of every edge are the OS resize border. A pointer
   * there belongs to the window manager, which shows a resize cursor; Chromium
   * is never asked and no view receives anything. The strip was unreachable by
   * a real mouse however it was styled.
   *
   * That was invisible to every in-process test, including a probe driving
   * `webContents.sendInputEvent` — injecting an event into a view starts below
   * the layer that was eating it, so the broken code passed. Only moving the
   * actual system cursor showed it.
   *
   * `screen.getCursorScreenPoint()` reads the OS cursor directly and is not
   * hit-tested, so it sees what the DOM cannot. It is a poll, which principle 1
   * would normally rule out, and it is kept honest by being **narrow**: it runs
   * only while auto-hide has actually hidden the chrome, stops the instant the
   * chrome is back, and stops while the window is not focused. Idle browsing
   * with the setting off never starts a timer.
   */
  setChromeAutoHidden(active: boolean, hidden: boolean): void {
    this.chromeIsHidden = hidden

    if (!active) {
      this.stopChromeReveal()
      return
    }
    if (this.chromeRevealTimer) return

    this.chromeRevealTimer = setInterval(() => {
      if (this.window.isDestroyed()) return this.stopChromeReveal()
      // Minimised is the only state where the cursor's position tells us
      // nothing. Focus deliberately is *not* required: this used to bail unless
      // the window was focused, so moving the pointer to the top of a Slash
      // window you had just clicked away from did nothing at all — which is
      // most of what "sometimes it doesn't work" was. Hovering an unfocused
      // window's chrome is a perfectly ordinary thing to do, and every other
      // browser responds to it.
      if (this.window.isMinimized()) return

      // `getContentBounds`, never `getBounds`, and this is the whole reason
      // auto-hide never came back on a maximised window.
      //
      // On Windows a maximised frame extends *past* every screen edge by the
      // invisible resize border: measured here, `getBounds` returns
      // `{x:-8, y:-8, width:1936, height:1048}` on a 1920x1032 work area while
      // `getContentBounds` returns `{x:0, y:0, width:1920, height:1032}`. A
      // reveal band of `[bounds.y, bounds.y + 8)` is therefore `[-8, 0)` —
      // entirely above the screen, where no cursor can ever be. It worked in
      // testing only because the test window happened to be restored.
      const bounds = this.window.getContentBounds()
      const point = screen.getCursorScreenPoint()
      const insideX = point.x >= bounds.x && point.x < bounds.x + bounds.width

      if (this.chromeIsHidden) {
        if (insideX && point.y >= bounds.y && point.y < bounds.y + CHROME_REVEAL_BAND) {
          this.chromeIsHidden = false
          this.deps.ipc.broadcast('ui:command', { command: 'reveal-chrome' }, this.privilegedContents())
        }
        return
      }

      // Hiding is driven from here too, and that is the fix for chrome that
      // felt twitchy. It used to be a DOM `mouseleave`, which fires the moment
      // the pointer crosses into the page - so the bars vanished while the
      // pointer was still a few pixels below them, on its way to a tab.
      //
      // The two thresholds are deliberately different. Revealing needs the very
      // top edge; hiding needs the pointer well clear of the chrome's own
      // bottom. That gap is hysteresis: with one threshold the pointer resting
      // near the boundary flips the state every poll, which is the flicker.
      const chromeBottom = bounds.y + this.layout.chromeHeightPx
      if (!insideX || point.y > chromeBottom + CHROME_HIDE_MARGIN) {
        this.chromeIsHidden = true
        this.deps.ipc.broadcast('ui:command', { command: 'hide-chrome' }, this.privilegedContents())
      }
    }, CHROME_REVEAL_POLL_MS)
  }

  private stopChromeReveal(): void {
    if (!this.chromeRevealTimer) return
    clearInterval(this.chromeRevealTimer)
    this.chromeRevealTimer = null
  }

  /**
   * Honours a page asking for fullscreen — a video, a game, a slide deck.
   *
   * Chromium fires these when a page calls `requestFullscreen()`, but it does
   * nothing about our layout: the page view kept its usual inset hole and the
   * toolbar and tab strip stayed drawn around it, so "fullscreen" was a video
   * boxed inside a browser. Giving the page view the whole content rect is what
   * actually covers the chrome, because that view composites above it.
   *
   * The OS window is taken fullscreen too, so the taskbar goes as well —
   * otherwise the page fills the window and the window still fills only part of
   * the screen.
   */
  private observePageFullscreen(contents: WebContents): void {
    // The window state change is deferred out of the event handler.
    //
    // Chromium is mid-handshake with the renderer when this fires, and taking
    // the OS window fullscreen synchronously inside it makes the renderer wait
    // on a window operation that is itself waiting on the renderer. The layout
    // is applied immediately — that is what covers the chrome — and only the
    // window call is pushed to the next tick.
    contents.on('enter-html-full-screen', () => {
      this.layout.setPageFullscreen(true)
      this.applyLayout()
      setImmediate(() => {
        if (this.window.isDestroyed()) return
        if (!this.window.isFullScreen()) this.window.setFullScreen(true)
        this.applyLayout()
      })
    })

    contents.on('leave-html-full-screen', () => {
      this.layout.setPageFullscreen(false)
      this.applyLayout()
      setImmediate(() => {
        if (this.window.isDestroyed()) return
        if (this.window.isFullScreen()) this.window.setFullScreen(false)
        this.applyLayout()
      })
    })

    // A tab closed or navigated away while fullscreen would otherwise strand
    // the window with no chrome and no page asking for it.
    contents.on('destroyed', () => {
      if (!this.layout.isPageFullscreen) return
      this.layout.setPageFullscreen(false)
      if (this.window.isFullScreen()) this.window.setFullScreen(false)
      this.applyLayout()
    })
  }

  private applyLayout(): void {
    const { width, height } = this.window.getContentBounds()
    const rects = this.layout.compute(width, height)
    this.chromeView.setBounds(rects.chrome)
    this.tabs.setPageBounds(rects.page)
    this.overlay.relayout(rects.full)
  }

  /**
   * Opens the print preview.
   *
   * Modal and focused, over the page it is previewing. Slash used to hand
   * straight to the operating system's print dialog, so there was no page range,
   * no scale, and no way to discover you were about to print forty pages of
   * navigation furniture until it was in the tray.
   */
  showPrintPreview(): void {
    const state = this.overlay.show('print', this.fullBounds(), {
      modal: true,
      takeFocus: true
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /**
   * Shows a sponsored notice in the browser's own chrome.
   *
   * The overlay, not the page. A sponsored strip injected into whatever site
   * somebody is reading is the behaviour Slash Shield exists to block, and
   * doing it ourselves would make this adware. Sized to a strip and **not
   * modal**, so the page underneath stays clickable throughout.
   */
  showSponsorNotice(creative: SponsoredTile): void {
    this.sponsorNotice = creative

    const { width, height } = this.window.getContentBounds()
    const stripHeight = 108
    const stripWidth = Math.min(520, Math.max(300, Math.round(width * 0.55)))
    const state = this.overlay.show(
      'sponsor-notice',
      {
        x: Math.round((width - stripWidth) / 2),
        y: Math.max(0, height - stripHeight - 24),
        width: stripWidth,
        height: stripHeight
      },
      { modal: false, takeFocus: false }
    )
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /** What `sponsor:currentNotice` answers with. */
  currentSponsorNotice(): SponsoredTile | null {
    return this.sponsorNotice
  }

  private sponsorNotice: SponsoredTile | null = null

  /**
   * Shows a transient message over the page.
   *
   * Exists because several browser-level actions can correctly do nothing —
   * there is no video to pop out, no text worth translating — and a control that
   * silently does nothing is indistinguishable from one that is broken.
   *
   * Sized to a strip at the bottom rather than the window, and **not modal**: an
   * overlay swallows every click inside its own bounds, so a full-window toast
   * would make the whole page inert for as long as it showed.
   */
  showNotice(
    message: string,
    tone: 'info' | 'warn' = 'info',
    action: { label: string; downloadUrl?: string; openUrl?: string } | null = null
  ): void {
    if (message.trim() === '') return
    this.notice = {
      message,
      tone,
      action: action
        ? {
            label: action.label,
            downloadUrl: action.downloadUrl ?? '',
            openUrl: action.openUrl ?? ''
          }
        : null
    }

    const { width, height } = this.window.getContentBounds()
    const stripHeight = 92
    const stripWidth = Math.min(460, Math.max(260, Math.round(width * 0.5)))
    const state = this.overlay.show(
      'notice',
      {
        x: Math.round((width - stripWidth) / 2),
        y: Math.max(0, height - stripHeight - 24),
        width: stripWidth,
        height: stripHeight
      },
      { modal: false, takeFocus: false }
    )
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /** What `notice:current` answers with. */
  currentNotice(): {
    message: string
    tone: 'info' | 'warn'
    action: { label: string; downloadUrl: string; openUrl: string } | null
  } {
    return this.notice
  }

  private notice: {
    message: string
    tone: 'info' | 'warn'
    action: { label: string; downloadUrl: string; openUrl: string } | null
  } = { message: '', tone: 'info', action: null }

  /**
   * Shows or hides the floating "download this video" chip.
   *
   * The affordance a download manager is recognised by: something appears over
   * the video, and one click saves it. It has to be the overlay — the page is a
   * native view composited above the chrome document, so a chip drawn in React
   * would be behind the video it is pointing at.
   *
   * **Passive by construction.** It never takes the overlay from a surface the
   * user opened: if a dialog, the palette or the reader is up, this does
   * nothing and tries again when that closes. The alternative is a browser
   * where opening the command palette over a video makes the palette vanish.
   *
   * Idempotent, because it is called from three places — detection, tab
   * activation, and the overlay becoming free — and re-showing an identical
   * chip would flicker it on every snapshot.
   */
  refreshMediaOffer(): void {
    const wanted = this.deps.mediaOffer?.(this) ?? null
    const showing = this.overlay.current.surface === 'media-offer'

    const suppressed =
      wanted === null ||
      this.mediaOfferDismissed === (this.tabs.activeTab?.contents?.id ?? -1) ||
      // Somebody else owns the overlay. Not an error — try again when it frees.
      (this.overlay.current.visible && !showing)

    if (suppressed) {
      if (showing) {
        const state = this.overlay.hide()
        this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
      }
      this.mediaOffer = null
      return
    }

    // Compared on the label too, not only the URL. A page that lists its own
    // formats has no single URL yet, so every YouTube video would have compared
    // equal and the chip would have kept the previous video's title.
    const unchanged =
      showing &&
      this.mediaOffer?.url === wanted.url &&
      this.mediaOffer?.filename === wanted.filename
    this.mediaOffer = wanted
    if (unchanged) return

    const { width, height } = this.window.getContentBounds()
    const page = this.layout.compute(width, height).page
    const chipWidth = Math.min(340, Math.max(240, page.width - 32))
    const chipHeight = 96

    const state = this.overlay.show(
      'media-offer',
      {
        // Top-right of the page area, where a player's own controls are not.
        x: Math.max(page.x, page.x + page.width - chipWidth - 16),
        y: page.y + 16,
        width: chipWidth,
        height: chipHeight
      },
      { modal: false, takeFocus: false }
    )
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /** What `media:offer` answers with. */
  currentMediaOffer(): MediaOffer | null {
    return this.mediaOffer
  }

  /**
   * Opens the picker over the page.
   *
   * Modal, unlike the chip that opens it. The chip is passive and must not take
   * a click away from the video; the picker is a direct answer to one, so
   * covering the page is right and the list needs the room.
   */
  showMediaPicker(): void {
    const state = this.overlay.show('media-picker', this.fullBounds(), {
      modal: true,
      takeFocus: true
    })
    this.deps.ipc.broadcast('overlay:stateChanged', state, this.privilegedContents())
  }

  /**
   * Remembers what the picker was shown, so a download can be checked against it.
   *
   * The renderer sends back a URL it was given. Without this it could send any
   * URL and have the browser fetch it, which is a different and much larger
   * capability than "save the video on this page".
   */
  rememberMediaChoices(urls: readonly string[], title: string): void {
    this.offeredMediaUrls = new Set(urls)
    this.offeredMediaTitle = title
  }

  wasOffered(url: string): boolean {
    return this.offeredMediaUrls.has(url)
  }

  get offeredTitle(): string {
    return this.offeredMediaTitle
  }

  private offeredMediaUrls = new Set<string>()
  private offeredMediaTitle = ''

  /**
   * Puts the chip away until this page changes.
   *
   * Keyed on the webContents rather than a flag, so navigating — or switching to
   * another tab that has a video — offers again. Dismissing one video is not a
   * statement about every video.
   */
  dismissMediaOffer(): void {
    this.mediaOfferDismissed = this.tabs.activeTab?.contents?.id ?? -1
    this.refreshMediaOffer()
  }

  private mediaOffer: MediaOffer | null = null
  private mediaOfferDismissed = -1

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
    this.stopChromeReveal()
    if (this.chromeTween) clearInterval(this.chromeTween)
    this.performance.stop()
    this.overlay.destroy()
    this.tabs.destroy()
    if (!this.chromeView.webContents.isDestroyed()) this.chromeView.webContents.close()
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}
