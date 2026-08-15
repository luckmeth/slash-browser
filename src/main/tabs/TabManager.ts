import type { BaseWindow, Rectangle, Session, WebContents, WebContentsView } from 'electron'
import { CLOSED_TAB_STACK_LIMIT, PAGE_RADIUS } from '@shared/constants'
import {
  NEW_TAB_URL,
  isInternalUrl,
  type TabsSnapshot,
  type Tab as TabSnapshot
} from '@shared/types/tab'
import { DEFAULT_WORKSPACE_ID } from '@shared/types/workspace'
import { createLogger } from '../logger'
import { installNavigationGuards } from '../navigation/NavigationGuards'
import { Tab } from './Tab'
import { attachTabEvents } from './TabEvents'
import { createPageView } from './ViewFactory'

const log = createLogger('tabs')

/** Index in the window's contentView child list where the page view belongs. */
const PAGE_VIEW_INDEX = 1

interface ClosedTab {
  url: string
  title: string
  faviconUrl: string | null
  index: number
  isPinned: boolean
  workspaceId: string
}

/** What TabManager needs to know about workspaces without owning them. */
export interface WorkspaceContext {
  sessionFor: (workspaceId: string) => Session
  isIsolated: (workspaceId: string) => boolean
}

export interface TabManagerHooks {
  onSnapshot: (snapshot: TabsSnapshot) => void
  onNavigated: (url: string, title: string, faviconUrl: string | null) => void
  /** A document finished loading — the Web Memory indexer's entry point. */
  onPageLoaded: (tab: Tab, url: string) => void
  onMetadata: (url: string, title: string, faviconUrl: string | null) => void
  /**
   * Attaches the right-click menu to a newly built page view.
   *
   * Injected rather than imported so TabManager stays unaware of workspaces,
   * bookmarks and the search engine setting, which the menu needs.
   */
  installPageContextMenu: (contents: WebContents) => void
  /**
   * A tab is gone or has navigated away.
   *
   * Anything scoped to it must be dropped: a permission prompt still on screen
   * would be attributing a request to a page that no longer exists, and an
   * allow-for-tab grant must not outlive the tab that was granted it.
   */
  onTabDiscarded: (tabId: string) => void
}

/**
 * Owns every tab in one window, across all workspaces, and decides which page
 * view is attached.
 *
 * Exactly one page view is a child of the window at a time — the active tab's.
 * Background tabs keep their `WebContentsView` alive but detached, so they carry
 * on loading and playing audio without compositing. Detaching rather than
 * stacking N views matters: Chromium composites every attached view, so leaving
 * fifty of them in the tree would cost GPU work for forty-nine invisible pages.
 *
 * Tabs from inactive workspaces stay alive too. Switching workspaces is
 * therefore instant and does not reload anything — it only changes which subset
 * the snapshot exposes and which view is attached.
 */
export class TabManager {
  private readonly tabs: Tab[] = []
  private readonly closed: ClosedTab[] = []
  /** Remembered per workspace so switching back restores where you were. */
  private readonly activeByWorkspace = new Map<string, string>()
  private activeWorkspaceId: string = DEFAULT_WORKSPACE_ID
  private attachedView: WebContentsView | null = null
  private pageBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private emitScheduled = false

  constructor(
    private readonly window: BaseWindow,
    private readonly workspaces: WorkspaceContext,
    private readonly hooks: TabManagerHooks
  ) {}

  // --- queries --------------------------------------------------------------

  /** Only the active workspace's tabs — this is what the tab strip renders. */
  private get visibleTabs(): Tab[] {
    return this.tabs.filter((t) => t.snapshot.workspaceId === this.activeWorkspaceId)
  }

  get activeId(): string | null {
    return this.activeByWorkspace.get(this.activeWorkspaceId) ?? null
  }

  snapshot(): TabsSnapshot {
    return {
      tabs: this.visibleTabs.map((t) => t.snapshot),
      activeTabId: this.activeId
    }
  }

  get activeTab(): Tab | null {
    const id = this.activeId
    return id ? (this.tabs.find((t) => t.id === id) ?? null) : null
  }

  findById(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  /** Total across all workspaces — used by Phase 3's performance engine. */
  allTabs(): Tab[] {
    return [...this.tabs]
  }

  get currentWorkspaceId(): string {
    return this.activeWorkspaceId
  }

  /**
   * Duplicate-tab detection, scoped to the active workspace. Compares ignoring a
   * trailing slash and the hash, so `example.com/docs` and `example.com/docs/#intro`
   * count as the same page — which is what a user means by "already open?".
   */
  findByUrl(url: string): TabSnapshot | null {
    const target = normaliseForComparison(url)
    return (
      this.visibleTabs.find((t) => normaliseForComparison(t.snapshot.url) === target)?.snapshot ??
      null
    )
  }

  // --- workspaces -----------------------------------------------------------

  setActiveWorkspace(workspaceId: string): void {
    if (workspaceId === this.activeWorkspaceId) return
    this.activeWorkspaceId = workspaceId

    const remembered = this.activeByWorkspace.get(workspaceId)
    const target =
      (remembered ? this.findById(remembered) : null) ??
      this.tabs.find((t) => t.snapshot.workspaceId === workspaceId) ??
      null

    if (target) {
      this.activate(target.id)
      return
    }

    // An empty workspace gets a new tab rather than a blank window.
    this.create({ url: NEW_TAB_URL })
  }

  /**
   * Moves a tab to another workspace.
   *
   * Crossing an isolation boundary means the tab's cookies and storage live in a
   * different partition, so the view must be rebuilt in the target session — and
   * the page necessarily reloads signed out. The caller is responsible for having
   * warned the user first; this method cannot un-sign-them-in afterwards.
   *
   * @returns whether the move required a reload.
   */
  moveToWorkspace(tabId: string, workspaceId: string): boolean {
    const tab = this.findById(tabId)
    if (!tab || tab.snapshot.workspaceId === workspaceId) return false

    const from = tab.snapshot.workspaceId
    const crossesBoundary =
      this.workspaces.sessionFor(from) !== this.workspaces.sessionFor(workspaceId)

    const wasActive = this.activeId === tabId
    if (wasActive) {
      this.activeByWorkspace.delete(from)
      this.detachCurrentView()
    }

    if (crossesBoundary) {
      this.destroyView(tab)
      tab.patch({ workspaceId, isLoading: false })
      // Rebuild lazily: only when the tab is next activated, so moving a
      // background tab does not spend a renderer process on it immediately.
    } else {
      tab.patch({ workspaceId })
    }

    // Give the source workspace something to focus if this was its last tab.
    if (wasActive) {
      const remaining = this.tabs.find((t) => t.snapshot.workspaceId === from)
      if (remaining) this.activeByWorkspace.set(from, remaining.id)
    }

    this.scheduleEmit()
    log.debug(`moved ${tabId} to ${workspaceId}${crossesBoundary ? ' (session boundary)' : ''}`)
    return crossesBoundary
  }

  /** Discards every tab of a deleted workspace. */
  discardWorkspace(workspaceId: string): void {
    for (const tab of this.tabs.filter((t) => t.snapshot.workspaceId === workspaceId)) {
      this.destroyView(tab)
      const index = this.tabs.indexOf(tab)
      if (index >= 0) this.tabs.splice(index, 1)
    }
    this.activeByWorkspace.delete(workspaceId)
    this.scheduleEmit()
  }

  // --- lifecycle ------------------------------------------------------------

  create(options: { url?: string; background?: boolean; afterTabId?: string } = {}): Tab {
    const tab = new Tab({ workspaceId: this.activeWorkspaceId, url: options.url ?? NEW_TAB_URL })

    const insertAt = this.insertionIndex(options.afterTabId)
    this.tabs.splice(insertAt, 0, tab)

    if (tab.needsView) this.buildView(tab)
    if (!options.background || this.activeId === null) this.activate(tab.id)
    else this.scheduleEmit()

    log.debug(`created ${tab.id} (${tab.snapshot.url})`)
    return tab
  }

  close(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index < 0) return
    const tab = this.tabs[index]
    if (!tab) return

    const snap = tab.snapshot
    const visibleIndex = this.visibleTabs.indexOf(tab)

    this.hooks.onTabDiscarded(id)

    // Internal pages are not worth reopening — Ctrl+Shift+T should bring back
    // something the user actually lost.
    if (!isInternalUrl(snap.url)) {
      this.closed.push({
        url: snap.url,
        title: snap.title,
        faviconUrl: snap.faviconUrl,
        index: visibleIndex,
        isPinned: snap.isPinned,
        workspaceId: snap.workspaceId
      })
      if (this.closed.length > CLOSED_TAB_STACK_LIMIT) this.closed.shift()
    }

    const siblings = this.visibleTabs
    this.destroyView(tab)
    this.tabs.splice(index, 1)

    if (this.activeId === id) {
      // Prefer the tab that took this one's place, then the one before it. This
      // is what makes closing a run of tabs feel like it stays in one spot.
      const next = siblings[visibleIndex + 1] ?? siblings[visibleIndex - 1] ?? null
      if (next) this.activate(next.id)
      else {
        this.activeByWorkspace.delete(this.activeWorkspaceId)
        this.detachCurrentView()
      }
    }

    this.scheduleEmit()
  }

  activate(id: string): void {
    const tab = this.findById(id)
    if (!tab) return

    // Activating a tab from another workspace switches to that workspace, which
    // is what makes "reopen closed tab" and cross-workspace search work.
    if (tab.snapshot.workspaceId !== this.activeWorkspaceId) {
      this.activeWorkspaceId = tab.snapshot.workspaceId
    }

    this.activeByWorkspace.set(this.activeWorkspaceId, id)
    tab.touch()

    // A hibernated or internal tab has no view; detaching leaves the chrome's
    // content area visible, which is exactly what renders the new tab page and
    // the hibernation placeholder.
    if (!tab.needsView) {
      this.detachCurrentView()
      this.scheduleEmit()
      return
    }

    // Waking a hibernated tab: rebuilding the view also restores its navigation
    // history, so the Back button survives the round trip.
    if (!tab.view) this.buildView(tab)
    if (tab.snapshot.isFrozen) this.thaw(id)
    tab.patch({ status: tab.snapshot.status === 'hibernated' ? 'live' : tab.snapshot.status })
    this.attachView(tab)
    this.scheduleEmit()
  }

  reopenClosed(): void {
    const entry = this.closed.pop()
    if (!entry) return
    const tab = new Tab({ workspaceId: entry.workspaceId, url: entry.url })
    tab.patch({ title: entry.title, faviconUrl: entry.faviconUrl, isPinned: entry.isPinned })
    this.tabs.push(tab)
    this.buildView(tab)
    this.activate(tab.id)
  }

  duplicate(id: string): void {
    const source = this.findById(id)
    if (!source) return
    this.create({ url: source.snapshot.url, afterTabId: id })
  }

  /**
   * Recreates tabs from a snapshot.
   *
   * Restored tabs are created *without* views. They materialise when activated,
   * which is what stops restoring forty tabs from launching forty renderer
   * processes at once — the same mechanism hibernation uses, so a restored
   * session starts light rather than thrashing the machine on launch.
   */
  restoreFromSnapshot(
    snapshotTabs: readonly {
      url: string
      title: string
      faviconUrl: string | null
      workspaceId: string
      isPinned: boolean
      scrollY: number
      entries: Array<{ url: string; title: string; pageState?: string }>
      activeEntryIndex: number
    }[],
    options: { activateFirst: boolean }
  ): number {
    let restored = 0
    let firstId: string | null = null

    for (const snapshotTab of snapshotTabs) {
      const tab = new Tab({
        workspaceId: snapshotTab.workspaceId,
        url: snapshotTab.url
      })
      tab.patch({
        title: snapshotTab.title,
        faviconUrl: snapshotTab.faviconUrl,
        isPinned: snapshotTab.isPinned,
        // No view yet, so it is genuinely hibernated rather than pretending to
        // be live and showing a blank page.
        status: 'hibernated'
      })
      tab.seedFromSnapshot(snapshotTab.entries, snapshotTab.activeEntryIndex, snapshotTab.scrollY)

      this.tabs.push(tab)
      if (!firstId) firstId = tab.id
      restored += 1
    }

    if (restored > 0) {
      // Pinned tabs form a block at the start, the same invariant setPinned
      // maintains. A stable sort keeps the snapshot's relative order inside
      // each block.
      const pinned = this.tabs.filter((tab) => tab.snapshot.isPinned)
      const rest = this.tabs.filter((tab) => !tab.snapshot.isPinned)
      this.tabs.length = 0
      this.tabs.push(...pinned, ...rest)

      if (options.activateFirst && firstId) this.activate(firstId)
      else this.scheduleEmit()
      log.info(`restored ${restored} tab(s) from snapshot`)
    }
    return restored
  }

  /** Closes every other tab in this workspace, keeping pinned ones. */
  closeOthers(keepId: string): void {
    // Snapshot the ids first: close() mutates the array being iterated.
    const doomed = this.visibleTabs
      .filter((tab) => tab.id !== keepId && !tab.snapshot.isPinned)
      .map((tab) => tab.id)
    for (const id of doomed) this.close(id)
  }

  /** Closes tabs after this one in the strip, keeping pinned ones. */
  closeToRight(fromId: string): void {
    const visible = this.visibleTabs
    const index = visible.findIndex((tab) => tab.id === fromId)
    if (index < 0) return
    const doomed = visible
      .slice(index + 1)
      .filter((tab) => !tab.snapshot.isPinned)
      .map((tab) => tab.id)
    for (const id of doomed) this.close(id)
  }

  // --- zoom -----------------------------------------------------------------

  /**
   * Chromium's zoom is per-webContents, so it is naturally per-tab. It resets
   * when a hibernated tab is rebuilt; persisting zoom per origin is a Phase 4
   * site-settings concern rather than something to fake here.
   */
  setZoomLevel(id: string, level: number): number {
    const contents = this.findById(id)?.contents
    if (!contents) return 0
    // Chromium's range; beyond it the page becomes unusable.
    const clamped = Math.max(-5, Math.min(5, level))
    contents.setZoomLevel(clamped)
    this.scheduleEmit()
    return clamped
  }

  getZoomLevel(id: string): number {
    return this.findById(id)?.contents?.getZoomLevel() ?? 0
  }

  // --- find in page ---------------------------------------------------------

  findInPage(id: string, text: string, options: { forward: boolean; findNext: boolean }): void {
    const contents = this.findById(id)?.contents
    if (!contents) return
    if (text === '') {
      contents.stopFindInPage('clearSelection')
      return
    }
    contents.findInPage(text, { forward: options.forward, findNext: options.findNext })
  }

  stopFindInPage(id: string, keepSelection: boolean): void {
    this.findById(id)?.contents?.stopFindInPage(
      keepSelection ? 'keepSelection' : 'clearSelection'
    )
  }

  print(id: string): void {
    // Opens Chromium's own print preview, the same dialog Chrome shows.
    this.findById(id)?.contents?.print()
  }

  // --- ordering -------------------------------------------------------------

  setPinned(id: string, pinned: boolean): void {
    const tab = this.findById(id)
    if (!tab || tab.snapshot.isPinned === pinned) return
    tab.patch({ isPinned: pinned })

    // Pinned tabs form a block at the start of the workspace's run. Reordering
    // the backing array keeps it sorted, so no view has to sort on read.
    const from = this.tabs.indexOf(tab)
    this.tabs.splice(from, 1)
    const boundary = this.lastPinnedIndex() + 1
    this.tabs.splice(boundary, 0, tab)
    this.scheduleEmit()
  }

  /**
   * Moves a tab within its own block. A pinned tab cannot be dragged into the
   * unpinned run or vice versa — the strip renders them as distinct regions, so
   * allowing it would let a drag silently change a tab's pinned state.
   *
   * `toIndex` is an index into the *visible* tabs, since that is what the strip
   * shows and therefore what a drag produces.
   */
  reorder(id: string, toIndex: number): void {
    const tab = this.findById(id)
    if (!tab) return

    const visible = this.visibleTabs
    const pinnedCount = visible.filter((t) => t.snapshot.isPinned).length
    const [lower, upper] = tab.snapshot.isPinned
      ? [0, Math.max(0, pinnedCount - 1)]
      : [pinnedCount, Math.max(pinnedCount, visible.length - 1)]

    const target = Math.min(Math.max(toIndex, lower), upper)
    const currentVisible = visible.indexOf(tab)
    if (target === currentVisible) return

    // Translate the visible index back to a position in the full array.
    const anchor = visible[target]
    if (!anchor) return
    const from = this.tabs.indexOf(tab)
    this.tabs.splice(from, 1)
    this.tabs.splice(this.tabs.indexOf(anchor) + (target > currentVisible ? 1 : 0), 0, tab)
    this.scheduleEmit()
  }

  setMuted(id: string, muted: boolean): void {
    const tab = this.findById(id)
    if (!tab) return
    tab.patch({ isMuted: muted })
    tab.contents?.setAudioMuted(muted)
    this.scheduleEmit()
  }

  // --- performance operations (Phase 3) -------------------------------------

  /** "Never Sleep". Protecting a frozen tab also thaws it. */
  setProtected(id: string, isProtected: boolean): void {
    const tab = this.findById(id)
    if (!tab) return
    tab.patch({ isProtected })
    if (isProtected && tab.snapshot.isFrozen) this.thaw(id)
    else this.scheduleEmit()
  }

  /**
   * FROZEN: the view stays detached and is explicitly marked hidden, so Chromium
   * fires `visibilitychange`, throttles timers and stops rAF. The renderer
   * process stays alive, so switching back is instant.
   *
   * Be clear about the size of this win: background tabs in this architecture are
   * already detached, so freezing mainly adds the explicit hidden signal. The
   * real memory reduction comes from `hibernate`, and only that one reports a
   * measured figure.
   */
  freeze(id: string): void {
    const tab = this.findById(id)
    if (!tab || tab.snapshot.isFrozen || id === this.activeId) return
    const view = tab.view
    if (!view) return

    if (view === this.attachedView) this.detachCurrentView()
    view.setVisible(false)
    // Safe because an audible tab can never reach here — `blockersFor` stops it.
    if (!tab.snapshot.isMuted) tab.contents?.setAudioMuted(true)

    tab.patch({ isFrozen: true })
    this.scheduleEmit()
    log.debug(`froze ${id}`)
  }

  /** Reverses `freeze`, restoring the user's own mute preference. */
  thaw(id: string): void {
    const tab = this.findById(id)
    if (!tab || !tab.snapshot.isFrozen) return
    tab.view?.setVisible(true)
    tab.contents?.setAudioMuted(tab.snapshot.isMuted)
    tab.patch({ isFrozen: false })
    this.scheduleEmit()
  }

  /**
   * HIBERNATED: destroys the `WebContentsView` outright, which is the only thing
   * that actually returns the renderer's memory to the system.
   *
   * Navigation history is captured first so the Back button survives, and the
   * working set is recorded so the dashboard can report a **measured** saving
   * rather than an estimate.
   *
   * Callers must have checked `ResourcePolicyEngine.blockersFor` — this method
   * refuses the active tab but does not re-derive the full guard set, so bypassing
   * the policy would be a way to destroy unsaved work.
   */
  hibernate(id: string, rssBeforeBytes: number | null): boolean {
    const tab = this.findById(id)
    if (!tab || !tab.view || id === this.activeId || !tab.needsView) return false

    tab.recordRssBeforeHibernate(rssBeforeBytes)
    this.destroyView(tab)
    tab.patch({ status: 'hibernated', isFrozen: false, isLoading: false })
    this.scheduleEmit()
    log.info(`hibernated ${id} (${rssBeforeBytes ?? 'unmeasured'} bytes)`)
    return true
  }

  /** Rebuilds a hibernated tab's view and restores its navigation history. */
  restore(id: string): void {
    const tab = this.findById(id)
    if (!tab || tab.view || !tab.needsView) return
    this.buildView(tab)
    tab.patch({ status: 'live' })
    if (this.activeId === id) this.attachView(tab)
    this.scheduleEmit()
  }

  // --- navigation -----------------------------------------------------------

  navigate(id: string, url: string): void {
    const tab = this.findById(id)
    if (!tab) return

    if (isInternalUrl(url)) {
      this.destroyView(tab)
      tab.patch({ url, title: '', faviconUrl: null, isLoading: false, error: null })
      if (this.activeId === id) this.detachCurrentView()
      this.scheduleEmit()
      return
    }

    tab.patch({ url, error: null })
    if (!tab.view) {
      this.buildView(tab)
      if (this.activeId === id) this.attachView(tab)
      return
    }
    void tab.contents?.loadURL(url)
    this.scheduleEmit()
  }

  goBack(id: string): void {
    const contents = this.findById(id)?.contents
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  }

  goForward(id: string): void {
    const contents = this.findById(id)?.contents
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  }

  reload(id: string, ignoreCache: boolean): void {
    const tab = this.findById(id)
    if (!tab) return

    // A crashed or hibernated tab has no live renderer to reload; rebuilding the
    // view issues the load itself, which is what makes the sad-tab's Reload
    // button work and what Phase 3 will reuse to wake a hibernated tab.
    if (!tab.contents) {
      if (!tab.needsView) return
      this.buildView(tab)
      if (this.activeId === id) this.attachView(tab)
      return
    }
    if (ignoreCache) tab.contents.reloadIgnoringCache()
    else tab.contents.reload()
  }

  stop(id: string): void {
    this.findById(id)?.contents?.stop()
  }

  // --- layout ---------------------------------------------------------------

  setPageBounds(bounds: Rectangle): void {
    this.pageBounds = bounds
    this.attachedView?.setBounds(bounds)
  }

  // --- internals ------------------------------------------------------------

  private lastPinnedIndex(): number {
    let last = -1
    this.tabs.forEach((tab, index) => {
      if (tab.snapshot.workspaceId === this.activeWorkspaceId && tab.snapshot.isPinned) last = index
    })
    return last
  }

  private insertionIndex(afterTabId: string | undefined): number {
    if (afterTabId) {
      const anchor = this.tabs.findIndex((t) => t.id === afterTabId)
      if (anchor >= 0) return anchor + 1
    }
    return this.tabs.length
  }

  private buildView(tab: Tab): void {
    const view = createPageView(this.workspaces.sessionFor(tab.snapshot.workspaceId))
    tab.attachView(view)

    attachTabEvents(view.webContents, tab, {
      onChanged: () => this.scheduleEmit(),
      onNavigated: (t, url) => this.hooks.onNavigated(url, t.snapshot.title, t.snapshot.faviconUrl),
      onPageLoaded: (t, url) => this.hooks.onPageLoaded(t, url),
      onMetadata: (t) =>
        this.hooks.onMetadata(t.snapshot.url, t.snapshot.title, t.snapshot.faviconUrl),
      onCrashed: () => this.scheduleEmit()
    })

    installNavigationGuards(view.webContents, {
      window: this.window,
      openInNewTab: (url, background) => {
        this.create({ url, background, afterTabId: tab.id })
      }
    })

    this.hooks.installPageContextMenu(view.webContents)

    if (tab.snapshot.isMuted) view.webContents.setAudioMuted(true)

    // Restore navigation history if this tab is waking from hibernation, so the
    // Back button survives. Falls back to a plain load when there is none.
    const saved = tab.takeSavedNavigation()
    if (saved && saved.entries.length > 0) {
      try {
        view.webContents.navigationHistory.restore({ entries: saved.entries, index: saved.index })
        return
      } catch (error) {
        log.warn(`could not restore navigation history for ${tab.id}`, error)
      }
    }
    void view.webContents.loadURL(tab.snapshot.url)
  }

  private attachView(tab: Tab): void {
    const view = tab.view
    if (!view || view === this.attachedView) return
    this.detachCurrentView()
    view.setBounds(this.pageBounds)
    // Rounded to match the gutter the layout leaves around it, so the page reads
    // as a pane sitting on the glass rather than a rectangle bolted into it.
    view.setBorderRadius(PAGE_RADIUS)
    // Covers the case where this view was previously frozen.
    view.setVisible(true)
    this.window.contentView.addChildView(view, PAGE_VIEW_INDEX)
    this.attachedView = view
  }

  /**
   * Removes the current page view from the window.
   *
   * Deliberately does **not** mark the view hidden. A merely-backgrounded tab
   * stays "visible" to Chromium so it is not throttled and switching back to it
   * is instant. Marking hidden is what `freeze` adds — that is the distinction
   * between BACKGROUND and FROZEN, and it is why the ladder has both.
   */
  private detachCurrentView(): void {
    if (!this.attachedView) return
    this.window.contentView.removeChildView(this.attachedView)
    this.attachedView = null
  }

  private destroyView(tab: Tab): void {
    const view = tab.view
    if (!view) return
    if (view === this.attachedView) this.detachCurrentView()
    tab.detachView()
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /**
   * Coalesces snapshot broadcasts.
   *
   * A single navigation fires did-start-loading, did-navigate, page-title-updated
   * and page-favicon-updated in quick succession. Broadcasting each one would
   * push four full snapshots and re-render the strip four times; one frame of
   * delay collapses them into a single update with no perceptible lag.
   */
  private scheduleEmit(): void {
    if (this.emitScheduled) return
    this.emitScheduled = true
    setTimeout(() => {
      this.emitScheduled = false
      this.hooks.onSnapshot(this.snapshot())
    }, 16)
  }

  /** Immediate, un-coalesced snapshot — for IPC handlers that return one. */
  emitNow(): TabsSnapshot {
    const snapshot = this.snapshot()
    this.hooks.onSnapshot(snapshot)
    return snapshot
  }

  destroy(): void {
    for (const tab of this.tabs) this.destroyView(tab)
    this.tabs.length = 0
    this.activeByWorkspace.clear()
  }
}

function normaliseForComparison(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    const text = parsed.toString()
    return text.endsWith('/') ? text.slice(0, -1) : text
  } catch {
    return url
  }
}
