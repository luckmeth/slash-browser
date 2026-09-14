import type { BaseWindow, Rectangle, Session, WebContents, WebContentsView } from 'electron'
import { CLOSED_TAB_STACK_LIMIT, PAGE_RADIUS } from '@shared/constants'
import {
  NEW_TAB_URL,
  isInternalUrl,
  type TabsSnapshot,
  type Tab as TabSnapshot
} from '@shared/types/tab'
import { DEFAULT_WORKSPACE_ID, type WorkspaceColor } from '@shared/types/workspace'
import type { TabGroup } from '@shared/types/tabGroup'
import { createLogger } from '../logger'
import { installNavigationGuards } from '../navigation/NavigationGuards'
import { Tab } from './Tab'
import { attachTabEvents } from './TabEvents'
import { createPageView } from './ViewFactory'
import { shouldWarmUp } from './warmUpRule'
import {
  splitRects,
  canSplit,
  SPLIT_GUTTER,
  type SplitOrientation
} from '../windows/splitLayout'

const log = createLogger('tabs')

/** Index in the window's contentView child list where the page view belongs. */
const PAGE_VIEW_INDEX = 1

/**
 * How long a navigation may wait for the page-world shield to be installed.
 *
 * Generous, because the measured install against a live renderer is 5–67 ms, so
 * reaching this at all means something is wrong. Bounded, because an unbounded
 * await here would mean a browser that never navigates.
 */
const SHIELD_WAIT_CEILING_MS = 1_500

/**
 * Whether this `WebContents` has a renderer process yet.
 *
 * `getOSProcessId()` returns **0** for a view that has never navigated — the
 * state every freshly built tab is in — and that is the difference between a
 * CDP command that is answered in milliseconds and one that is never answered
 * at all. Measured, not inferred: see `afterShield`.
 */
function hasRenderer(contents: WebContents): boolean {
  try {
    return !contents.isDestroyed() && contents.getOSProcessId() > 0
  } catch {
    return false
  }
}

export interface ClosedTab {
  url: string
  title: string
  faviconUrl: string | null
  index: number
  isPinned: boolean
  workspaceId: string
  /** Serialised back/forward history, so a reopened tab keeps its Back button. */
  navigation: string
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
  /** Wires a new page view's navigation events into Redirect X-Ray. */
  observeRedirects?: (tabId: string, contents: WebContents) => void
  /**
   * Resolves once page-world protection is registered for this view.
   *
   * Awaited before the first load so the YouTube ad strip is in place before
   * the page can read its player data — see `ScriptletInjector.ready`.
   */
  shieldReady?: (contents: WebContents) => Promise<void>
  /** Whether this destination is one worth delaying the load for. */
  shieldNeededFor?: (url: string) => boolean
  /** Wires a new page view into media detection, so it can be offered for download. */
  observeMedia?: (contents: WebContents) => void
  /**
   * A tab is gone or has navigated away.
   *
   * Anything scoped to it must be dropped: a permission prompt still on screen
   * would be attributing a request to a page that no longer exists, and an
   * allow-for-tab grant must not outlive the tab that was granted it.
   */
  onTabDiscarded: (tabId: string) => void
  /**
   * Slash Shield's verdict on a `window.open`.
   *
   * Optional so a TabManager can be built without the shield — returning true
   * when it is absent keeps popup behaviour exactly as it was.
   */
  shouldAllowPopup?: (tab: Tab, url: string, webContentsId: number) => boolean
  /** Slash Shield's verdict on a page-initiated top-level navigation. */
  shouldAllowNavigation?: (tab: Tab, url: string, webContentsId: number) => boolean
  /** A tab closed — persisted so reopening it survives a restart. */
  onTabClosed?: (entry: ClosedTab & { closedAt: number }) => void
  /** The most recent persisted closed tab, consumed by reopen. */
  takeClosedTab?: () => ClosedTab | null
  /** Every persisted closed tab, for a caller that offers a choice of them. */
  listClosedTabs?: () => (ClosedTab & { id: number; closedAt: number })[]
  /** One particular persisted closed tab, consumed by reopening from a list. */
  takeClosedTabAt?: (id: number) => ClosedTab | null
  /** Groups changed — written through so an arrangement survives a crash. */
  onGroupsChanged?: (groups: readonly TabGroup[]) => void
  /**
   * A tab was hibernated, and this many bytes were genuinely released.
   *
   * Null when the working set could not be read. The weekly report counts the
   * tab either way and only adds the bytes when there are some — a projected
   * figure here would turn the one measured number in the browser into a guess.
   */
  onHibernated?: (bytesFreed: number | null) => void
  /** The remembered zoom for a URL's host, or null at the default. */
  siteZoomFor?: (url: string) => number | null
  /** The user changed zoom on this host; remember it for next time. */
  onSiteZoomChanged?: (url: string, level: number) => void
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
  /**
   * The second pane's view, when split view is on.
   *
   * Split view is the one case where two page views are attached at once. The
   * "only the active tab is attached" rule exists because Chromium composites
   * every attached view, so N attached views cost GPU work for N-1 invisible
   * pages — here both panes are genuinely visible, so both are genuinely worth
   * compositing. It stays capped at two for exactly that reason.
   */
  private attachedSecondary: WebContentsView | null = null
  /** Per workspace: a split belongs to the tabs it was made from. */
  private readonly splitByWorkspace = new Map<string, string>()
  private splitFraction = 0.5
  private splitOrientation: SplitOrientation = 'vertical'
  /** Gutter and content rects, recomputed whenever the panes move. */
  private splitGeometry: TabsSnapshot['splitGeometry'] = null
  /**
   * Coloured runs of tabs, across every workspace.
   *
   * Held here rather than in a separate service because grouping is an ordering
   * concern and this class already owns tab order — a group that could not
   * reorder the strip would not be a group.
   */
  private groups: TabGroup[] = []
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

  /** The tab in the second pane, or null when split view is off. */
  get splitId(): string | null {
    return this.splitByWorkspace.get(this.activeWorkspaceId) ?? null
  }

  snapshot(): TabsSnapshot {
    return {
      tabs: this.visibleTabs.map((t) => t.snapshot),
      activeTabId: this.activeId,
      splitTabId: this.splitId,
      splitFraction: this.splitFraction,
      groups: this.groups.filter((g) => g.workspaceId === this.activeWorkspaceId),
      splitOrientation: this.splitOrientation,
      canSplit: canSplit(this.pageBounds, this.splitOrientation),
      splitGeometry: this.splitGeometry
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

  /**
   * Whether a page view is currently on the window.
   *
   * False for internal pages, hibernated tabs and tabs showing an error — the
   * three cases where the chrome document is what fills the content hole.
   */
  get hasAttachedView(): boolean {
    return this.attachedView !== null
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

  /** True when a tab was found and closed; false when the id names nothing. */
  close(id: string): boolean {
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index < 0) return false
    const tab = this.tabs[index]
    if (!tab) return false

    const snap = tab.snapshot
    const visibleIndex = this.visibleTabs.indexOf(tab)

    this.hooks.onTabDiscarded(id)

    // Internal pages are not worth reopening — Ctrl+Shift+T should bring back
    // something the user actually lost.
    if (!isInternalUrl(snap.url)) {
      // Capture back/forward history before the view is destroyed — after that
      // there is nothing left to ask, and a reopened tab with a dead Back button
      // is only half the tab you lost.
      let navigation = ''
      const contents = tab.contents
      if (contents && !contents.isDestroyed()) {
        try {
          navigation = JSON.stringify({
            entries: contents.navigationHistory.getAllEntries(),
            activeIndex: contents.navigationHistory.getActiveIndex()
          })
        } catch {
          // A renderer that has already gone simply contributes no history.
        }
      }

      const entry: ClosedTab = {
        url: snap.url,
        title: snap.title,
        faviconUrl: snap.faviconUrl,
        index: visibleIndex,
        isPinned: snap.isPinned,
        workspaceId: snap.workspaceId,
        navigation
      }
      this.closed.push(entry)
      if (this.closed.length > CLOSED_TAB_STACK_LIMIT) this.closed.shift()
      // Written through immediately rather than on quit: a crash is one of the
      // times you most want the tab back, and a flush at shutdown never runs.
      this.hooks.onTabClosed?.({ ...entry, closedAt: Date.now() })
    }

    const siblings = this.visibleTabs
    // Closing either pane ends the split rather than leaving one attributed to
    // a tab that no longer exists.
    if (this.splitByWorkspace.get(tab.snapshot.workspaceId) === id) {
      this.splitByWorkspace.delete(tab.snapshot.workspaceId)
      this.detachSecondary()
    }
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
    return true
  }

  activate(id: string): void {
    const tab = this.findById(id)
    if (!tab) return

    // Activating a tab from another workspace switches to that workspace, which
    // is what makes "reopen closed tab" and cross-workspace search work.
    if (tab.snapshot.workspaceId !== this.activeWorkspaceId) {
      this.activeWorkspaceId = tab.snapshot.workspaceId
    }

    // Clicking the tab already showing in the second pane swaps the panes
    // rather than collapsing the split — the alternative is that selecting a
    // visible tab makes it disappear from where it was.
    if (id === this.splitId) {
      const previous = this.activeId
      if (previous && previous !== id) this.splitByWorkspace.set(this.activeWorkspaceId, previous)
      else this.splitByWorkspace.delete(this.activeWorkspaceId)
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

  /**
   * Brings back the most recently closed tab.
   *
   * Falls through to the persisted list when this window's own stack is empty,
   * which is what makes the shortcut work after a restart — the moment you are
   * most likely to want a tab back is just after reopening the browser, and that
   * used to be exactly when the list was empty.
   */
  reopenClosed(): void {
    const entry = this.closed.pop() ?? this.hooks.takeClosedTab?.() ?? null
    if (!entry) return
    this.restoreClosed(entry)
  }

  /**
   * Every closed tab a caller could offer, newest first.
   *
   * Read from the persisted list rather than this window's stack, because every
   * close is written through immediately — so the stored list is the complete
   * one, and the in-memory stack is a subset of it held for the shortcut's sake.
   */
  listClosedTabs(): (ClosedTab & { id: number; closedAt: number })[] {
    return (this.hooks.listClosedTabs?.() ?? []).slice().reverse()
  }

  /**
   * Brings back one particular closed tab.
   *
   * Separate from `reopenClosed`, which is the Ctrl+Shift+T stack. Taking it out
   * of *both* stores matters: the same tab sits in the persisted list and, until
   * the browser restarts, in this window's stack — and reopening one from a list
   * should not leave a copy behind for the shortcut to produce a second time.
   */
  reopenClosedAt(id: number): void {
    const entry = this.hooks.takeClosedTabAt?.(id) ?? null
    if (!entry) return

    const stacked = this.closed.findIndex(
      (candidate) => candidate.url === entry.url && candidate.workspaceId === entry.workspaceId
    )
    if (stacked !== -1) this.closed.splice(stacked, 1)

    this.restoreClosed(entry)
  }

  private restoreClosed(entry: ClosedTab): void {
    const tab = new Tab({ workspaceId: entry.workspaceId, url: entry.url })
    tab.patch({ title: entry.title, faviconUrl: entry.faviconUrl, isPinned: entry.isPinned })

    // Hand back the history before the view exists, so buildView restores it the
    // same way waking a hibernated tab does.
    if (entry.navigation) {
      try {
        const saved = JSON.parse(entry.navigation) as {
          entries?: unknown[]
          activeIndex?: number
        }
        if (Array.isArray(saved.entries) && saved.entries.length > 0) {
          tab.seedFromSnapshot(
            saved.entries as never,
            saved.activeIndex ?? saved.entries.length - 1,
            0
          )
        }
      } catch {
        // Unparseable history is not a reason to refuse the tab.
      }
    }

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
      groupId?: string | null
      scrollY: number
      entries: Array<{ url: string; title: string; pageState?: string }>
      activeEntryIndex: number
    }[],
    options: { activateFirst: boolean }
  ): string[] {
    // The ids rather than a count, so a caller can offer an undo. Restoring is
    // additive — nothing is destroyed — but it can put twenty tabs in front of
    // somebody who meant to look before they leapt, and the only honest way
    // back is to close exactly the tabs that arrived.
    const restoredIds: string[] = []
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
        // Membership travels with the tab, so a restored session brings back the
        // arrangement and not only the pages. A group id naming a group that no
        // longer exists is dropped below rather than left dangling.
        groupId: snapshotTab.groupId ?? null,
        // No view yet, so it is genuinely hibernated rather than pretending to
        // be live and showing a blank page.
        status: 'hibernated'
      })
      tab.seedFromSnapshot(snapshotTab.entries, snapshotTab.activeEntryIndex, snapshotTab.scrollY)

      this.tabs.push(tab)
      if (!firstId) firstId = tab.id
      restoredIds.push(tab.id)
    }

    if (restoredIds.length > 0) {
      // Pinned tabs form a block at the start, the same invariant setPinned
      // maintains. A stable sort keeps the snapshot's relative order inside
      // each block.
      const pinned = this.tabs.filter((tab) => tab.snapshot.isPinned)
      const rest = this.tabs.filter((tab) => !tab.snapshot.isPinned)
      this.tabs.length = 0
      this.tabs.push(...pinned, ...rest)

      // A restored tab may name a group whose row is gone. Clearing it here
      // keeps the strip honest: a tab tinted for a group that no longer exists
      // would be coloured by nothing.
      const known = new Set(this.groups.map((group) => group.id))
      for (const tab of this.tabs) {
        const groupId = tab.snapshot.groupId
        if (groupId && !known.has(groupId)) tab.patch({ groupId: null })
      }

      if (options.activateFirst && firstId) this.activate(firstId)
      else this.scheduleEmit()
      log.info(`restored ${restoredIds.length} tab(s) from snapshot`)
    }
    return restoredIds
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
    const tab = this.findById(id)
    const contents = tab?.contents
    if (!tab || !contents) return 0
    // Chromium's range; beyond it the page becomes unusable.
    const clamped = Math.max(-5, Math.min(5, level))
    contents.setZoomLevel(clamped)
    // Remembered per host, so a site that needs enlarging is enlarged the next
    // time you visit it — including after a restart, which Chromium's own
    // per-origin zoom does not survive.
    this.hooks.onSiteZoomChanged?.(tab.snapshot.url, clamped)
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
    this.hooks.onHibernated?.(rssBeforeBytes)
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
    // The view may be detached because this tab was showing an error page. The
    // error has just been cleared, so the renderer has to come back — otherwise
    // the page loads correctly into a view nobody can see.
    if (this.activeId === id) this.attachView(tab)
    const target = tab.contents
    if (target) this.afterShield(target, url, () => void target.loadURL(url))
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
    // Retrying from the error page: clearing the error is what lets the view be
    // attached again, and `did-start-navigation` would clear it a moment later
    // anyway — doing it here means the page is on screen from the first frame
    // rather than after a flash of the error.
    if (tab.snapshot.error) {
      tab.patch({ error: null })
      if (this.activeId === id) this.attachView(tab)
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
    this.layoutPanes()
    // A window narrowed past two usable panes drops the split rather than
    // rendering slivers. Widening again does not restore it: silently
    // reinstating a layout the user last saw disappear is worse than leaving
    // them to ask for it back.
    if (this.splitId && !canSplit(bounds, this.splitOrientation)) this.setSplit(null)
  }

  /**
   * Puts a second tab beside the active one.
   *
   * The second pane is *not* the active tab: keyboard focus, the omnibox and
   * every per-tab control still follow `activeId`, so there is exactly one tab
   * the browser considers current. Splitting is a way to see two pages, not a
   * second cursor.
   *
   * Refused when the hole cannot hold two usable panes, when the tab is the
   * active one, or when it lives in another workspace — a split across an
   * isolation boundary would put two partitions side by side under one tab
   * strip, which reads as one context and is not.
   */
  setSplit(tabId: string | null): boolean {
    if (tabId === null) {
      if (!this.splitByWorkspace.has(this.activeWorkspaceId)) return true
      this.splitByWorkspace.delete(this.activeWorkspaceId)
      this.detachSecondary()
      this.layoutPanes()
      this.scheduleEmit()
      return true
    }

    const tab = this.findById(tabId)
    if (!tab) return false
    if (tab.snapshot.workspaceId !== this.activeWorkspaceId) return false
    if (tabId === this.activeId) return false
    if (!canSplit(this.pageBounds, this.splitOrientation)) return false

    this.splitByWorkspace.set(this.activeWorkspaceId, tabId)
    this.layoutPanes()
    this.scheduleEmit()
    return true
  }

  /**
   * Docks an AI assistant beside the current page, or undocks it.
   *
   * Built on split view rather than a new native surface, because the assistant
   * *is* a web page — the whole approach is that the user signs into the real
   * site with the subscription they already pay for, rather than Slash asking
   * for an API key it would bill again. A second pane is exactly what that
   * needs, and it already exists, tested.
   *
   * An assistant tab already open is reused rather than duplicated: it usually
   * holds a conversation somebody is in the middle of, and opening a second one
   * would strand it.
   *
   * Returns false when the window is too narrow for two usable panes. The
   * caller says so; silently doing nothing is how a shortcut gets reported as
   * broken.
   */
  openAssistant(url: string, isAssistant: (url: string) => boolean): boolean {
    // Already docked: this is a toggle, so put it away.
    const docked = this.splitId
    if (docked !== null && isAssistant(this.findById(docked)?.snapshot.url ?? '')) {
      return this.setSplit(null)
    }

    if (!canSplit(this.pageBounds, this.splitOrientation)) return false

    const existing = this.tabs.find(
      (tab) =>
        tab.snapshot.workspaceId === this.activeWorkspaceId &&
        tab.id !== this.activeId &&
        isAssistant(tab.snapshot.url)
    )
    if (existing) return this.setSplit(existing.id)

    // Background, so focus stays on the page being read. The assistant is
    // beside the work, not instead of it.
    const created = this.create({ url, background: true })
    return this.setSplit(created.id)
  }

  /** Drag the divider. Clamped by `splitRects`, so any value is safe here. */
  setSplitFraction(fraction: number): void {
    if (!Number.isFinite(fraction)) return
    this.splitFraction = fraction
    this.layoutPanes()
    this.scheduleEmit()
  }

  setSplitOrientation(orientation: SplitOrientation): void {
    this.splitOrientation = orientation
    if (this.splitId && !canSplit(this.pageBounds, orientation)) {
      this.setSplit(null)
      return
    }
    this.layoutPanes()
    this.scheduleEmit()
  }

  /** Swap which pane is the active tab. */
  swapSplit(): void {
    const other = this.splitId
    const current = this.activeId
    if (!other || !current) return
    this.splitByWorkspace.set(this.activeWorkspaceId, current)
    this.activate(other)
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
    const contents = view.webContents

    // Read **now**, before anything can navigate. The warm-up below loads a
    // blank document, and `did-navigate` patches `tab.snapshot.url` — so a
    // closure that re-read the snapshot later found `about:blank` and loaded
    // that instead of the page the user asked for. The tab then sat blank for
    // twenty seconds with the correct address logged one line above it.
    // Captured by value so there is nothing to re-read.
    const initialUrl = tab.snapshot.url
    const saved = tab.takeSavedNavigation()

    const start = (): void => {
      if (contents.isDestroyed() || tab.view !== view) return
      this.wireView(tab, view)

      // Restore navigation history if this tab is waking from hibernation, so
      // the Back button survives. Falls back to a plain load when there is
      // none.
      //
      // Both branches go through `afterShield`. The restore branch used to
      // `return` before the wait entirely, which is precisely the path a
      // browser takes when it reopens with restored tabs — the case the ad race
      // was actually reported from.
      if (saved && saved.entries.length > 0) {
        this.afterShield(contents, initialUrl, () => {
          try {
            contents.navigationHistory.restore({ entries: saved.entries, index: saved.index })
          } catch (error) {
            log.warn(`could not restore navigation history for ${tab.id}`, error)
            void contents.loadURL(initialUrl)
          }
        })
        return
      }
      this.afterShield(contents, initialUrl, () => {
        contents.loadURL(initialUrl).catch((error: unknown) => {
          log.warn(`initial load of ${initialUrl} failed`, error)
        })
      })
    }

    // The renderer warm-up, and the reason it happens *here* rather than beside
    // the navigation it serves.
    //
    // `SLASH_SHIELD_WARMUP_PROBE`: a view that has never navigated has no
    // renderer process at all (`getOSProcessId()` returns 0), and
    // `Page.addScriptToEvaluateOnNewDocument` is serviced in the renderer — so
    // the shield's install was never answered until the navigation to YouTube
    // spawned one, ~300 ms into the life of the page it was supposed to
    // protect. A blank document costs a spawn the tab was going to pay for
    // anyway and takes the install from *never* to 4 ms.
    //
    // It runs before `wireView` so that it is invisible. With the tab's own
    // listeners already attached, the blank navigation patched the tab's URL,
    // put `about:blank` in the omnibox, and **recorded it as a visit in the
    // user's history**.
    // **Never warm up a tab that is being restored.**
    //
    // `navigationHistory.restore()` replaces the entry list on a *pristine*
    // WebContents. Give it one that has already committed a document — which is
    // exactly what the blank warm-up does — and it replaces the entries without
    // navigating: the tab keeps the restored address in the omnibox and renders
    // nothing at all. Reopening the browser showed a black window with the right
    // URL above it, on every restored tab.
    //
    // This is the one path where the blank document is not free, and it is also
    // the path that needs it least: a restore is a navigation like any other, so
    // the shield installs during it as it did before any of this existed.
    if (saved && saved.entries.length > 0) {
      start()
      return
    }

    if (!this.needsWarmUp(contents, initialUrl)) {
      start()
      return
    }
    void contents
      .loadURL('about:blank')
      .catch(() => undefined)
      .then(start)
  }

  /**
   * Whether this view should be given a blank document before it navigates.
   *
   * Only where the shield is time-critical, and only when there is no renderer
   * yet. Principle 1 forbids adding latency to the browsing path, and every
   * other destination's scripts are defensive rather than time-critical — a
   * pop-up defuser that installs 60 ms late has missed nothing, because nothing
   * has tried to open a window yet.
   */
  private needsWarmUp(contents: WebContents, url: string): boolean {
    // An escape hatch, and the reason it exists: the warm-up navigates
    // `about:blank` -> the real site, which is a **cross-process** swap, and a
    // script registered against the first renderer carrying over to the second
    // is an assumption rather than a fact. This switch is what lets the probe
    // measure the fix against the unfixed code — a fix that has never been
    // shown capable of failing has not been tested.
    if (process.env['SLASH_NO_SHIELD_WARMUP'] === '1') return false

    return shouldWarmUp({
      url,
      // Callers check this themselves before building; passed as false here
      // because `buildView` returns early for a restore and never reaches this.
      hasSavedNavigation: false,
      hasRenderer: hasRenderer(contents),
      hasScripts: this.hooks.shieldNeededFor?.(url) ?? false
    })
  }

  /** Everything that listens to a page. Split out so the warm-up can precede it. */
  private wireView(tab: Tab, view: WebContentsView): void {
    attachTabEvents(view.webContents, tab, {
      onChanged: () => this.scheduleEmit(),
      siteZoomFor: (url) => this.hooks.siteZoomFor?.(url) ?? null,
      onNavigated: (t, url) => this.hooks.onNavigated(url, t.snapshot.title, t.snapshot.faviconUrl),
      onPageLoaded: (t, url) => this.hooks.onPageLoaded(t, url),
      onMetadata: (t) =>
        this.hooks.onMetadata(t.snapshot.url, t.snapshot.title, t.snapshot.faviconUrl),
      onCrashed: () => this.scheduleEmit(),
      onLoadFailed: (failed) => {
        // `needsView` is now false for this tab, so detaching is what makes the
        // chrome's error page visible. The view is kept rather than destroyed:
        // Retry is a reload, and rebuilding a renderer is slower than reusing
        // the one already there.
        if (this.activeId === failed.id) this.detachCurrentView()
        this.scheduleEmit()
      }
    })

    installNavigationGuards(view.webContents, {
      window: this.window,
      openInNewTab: (url, background) => {
        this.create({ url, background, afterTabId: tab.id })
      },
      shouldAllowPopup: (url) =>
        this.hooks.shouldAllowPopup?.(tab, url, view.webContents.id) ?? true,
      shouldAllowNavigation: (url) =>
        this.hooks.shouldAllowNavigation?.(tab, url, view.webContents.id) ?? true
    })

    this.hooks.installPageContextMenu(view.webContents)
    this.hooks.observeRedirects?.(tab.id, view.webContents)
    this.hooks.observeMedia?.(view.webContents)

    if (tab.snapshot.isMuted) view.webContents.setAudioMuted(true)
  }

  /**
   * Runs a navigation, with the page-world shield installed **first**.
   *
   * The bug this exists for: adverts played on the first YouTube video after a
   * fresh start and on no video after it. The cause, measured by
   * `SLASH_SHIELD_WARMUP_PROBE` rather than reasoned about:
   *
   *     never navigated      pid      0 ->      0   install never (> 5000ms)
   *     after about:blank    pid  32028 ->  32028   install 5ms
   *
   * **A tab that has never navigated has no renderer process** — `getOSProcessId()`
   * returns literally 0 — and `Page.addScriptToEvaluateOnNewDocument` is serviced
   * *in* the renderer. So the install command sat unanswered indefinitely, and
   * the thing that finally answered it was the renderer spawned by the
   * navigation to YouTube. The shield was being switched on by the very page it
   * was supposed to be protecting, ~300 ms into that page's life, which is after
   * the player has read `ytInitialPlayerResponse`. Every navigation afterwards
   * found it already installed — exactly the shape of "only the first video".
   *
   * An earlier round here simply waited longer, which is why the ceilings looked
   * circular (250 -> installed 423, 900 -> 1196, 2500 -> 2897): with no renderer
   * to answer, waiting bought nothing and delayed the page. The fix is not a
   * longer wait but **a renderer to install into** — a blank document, which
   * costs a spawn the tab was going to pay for anyway.
   */
  private afterShield(contents: WebContents, url: string, run: () => void): void {
    if (contents.isDestroyed()) return

    // Ordinary browsing is never held up. Principle 1 forbids adding latency to
    // the browsing path, and "we might need a script eventually" is not a
    // reason to make every page wait for a debugger.
    if (!this.hooks.shieldNeededFor?.(url)) {
      run()
      return
    }

    // Bounded, and it degrades to navigating unprotected rather than to not
    // navigating at all. An await with no ceiling is how the Android port
    // shipped a browser that opened with no tabs and no error explaining why.
    //
    // The renderer this waits on was warmed in `buildView`, so on the path that
    // matters this promise is already a few milliseconds old.
    void Promise.race([
      this.hooks.shieldReady?.(contents) ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, SHIELD_WAIT_CEILING_MS))
    ]).then(() => {
      if (contents.isDestroyed()) return
      log.debug(`shield seam releasing navigation to ${url}`)
      this.forgetWarmUpEntry(contents)
      run()
    })
  }

  /**
   * Drops the `about:blank` the warm-up left behind, once the real page has
   * committed.
   *
   * Measured, because it is exactly the kind of side effect that is easy to
   * assume away: Chromium replaces the *initial* empty document on the next
   * navigation, but a blank page we asked for explicitly is a history entry
   * like any other. The probe found it — `entries=2 about:blank=1`, with Back
   * enabled on a tab the user had just opened — and a Back button that returns
   * to a blank page is a worse bug than the advert.
   *
   * One-shot, and only for an entry at index 0 that is genuinely ours.
   */
  private forgetWarmUpEntry(contents: WebContents): void {
    const drop = (): void => {
      try {
        if (contents.isDestroyed()) return
        const entries = contents.navigationHistory.getAllEntries()
        if (entries.length < 2) return
        if (entries[0]?.url !== 'about:blank') return
        contents.navigationHistory.removeEntryAtIndex(0)
      } catch (error) {
        // A history that will not be edited is a cosmetic fault, not a reason
        // to fail the navigation that is already under way.
        log.debug('could not drop the warm-up history entry', error)
      }
    }
    contents.once('did-navigate', drop)
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
    this.layoutPanes()
  }

  /**
   * Positions whichever panes are attached, and attaches or drops the second
   * one to match the split state.
   *
   * Single place that decides page-view geometry, so the split can never be
   * half-applied: every entry point — activating, closing, resizing, dragging
   * the divider, opening a side panel — ends up here.
   */
  private layoutPanes(): void {
    const splitTab = this.splitId ? this.findById(this.splitId) : null

    // A hibernated, internal or errored second tab has no view to show. Rather
    // than leaving a hole where a pane should be, the split simply stops until
    // that tab is real again.
    const rects =
      splitTab && splitTab.needsView && this.attachedView
        ? splitRects(this.pageBounds, this.splitFraction, this.splitOrientation)
        : null

    if (!rects || !splitTab) {
      this.detachSecondary()
      this.splitGeometry = null
      this.attachedView?.setBounds(this.pageBounds)
      return
    }

    if (!splitTab.view) this.buildView(splitTab)
    const secondary = splitTab.view
    if (!secondary) {
      this.detachSecondary()
      this.splitGeometry = null
      this.attachedView?.setBounds(this.pageBounds)
      return
    }

    // The gutter between the panes, in the same coordinates the views use. The
    // chrome document spans the whole content area, so it can place a drag
    // handle at exactly these numbers without repeating the arithmetic.
    this.splitGeometry = {
      divider:
        this.splitOrientation === 'vertical'
          ? {
              x: rects.primary.x + rects.primary.width,
              y: rects.primary.y,
              width: SPLIT_GUTTER,
              height: rects.primary.height
            }
          : {
              x: rects.primary.x,
              y: rects.primary.y + rects.primary.height,
              width: rects.primary.width,
              height: SPLIT_GUTTER
            },
      content: this.pageBounds
    }

    this.attachedView?.setBounds(rects.primary)

    if (this.attachedSecondary !== secondary) {
      this.detachSecondary()
      secondary.setBorderRadius(PAGE_RADIUS)
      secondary.setVisible(true)
      this.window.contentView.addChildView(secondary, PAGE_VIEW_INDEX)
      this.attachedSecondary = secondary
    }
    secondary.setBounds(rects.secondary)
  }

  // --- groups ---------------------------------------------------------------

  /**
   * Loads persisted groups at startup.
   *
   * Membership lives on the tab, so this only restores the groups themselves.
   * Ids belonging to no restored tab are pruned by the caller — an empty group
   * left over from a previous session is clutter with nothing in it.
   */
  loadGroups(groups: readonly TabGroup[]): void {
    this.groups = [...groups]
    this.scheduleEmit()
  }

  groupsForProbe(): readonly TabGroup[] {
    return this.groups
  }

  /**
   * Makes a group from the given tabs and gathers them into a contiguous run.
   *
   * Tabs from other workspaces are ignored rather than dragged across: a group
   * is presentation inside one workspace, and pulling a tab over an isolation
   * boundary would reload it signed out — far too much to do as a side effect of
   * naming something.
   */
  createGroup(tabIds: readonly string[], init: { name: string; color: WorkspaceColor }): string | null {
    const members = tabIds
      .map((id) => this.findById(id))
      .filter((tab): tab is Tab => tab !== null && tab.snapshot.workspaceId === this.activeWorkspaceId)
    if (members.length === 0) return null

    const group: TabGroup = {
      id: `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      workspaceId: this.activeWorkspaceId,
      name: init.name,
      color: init.color,
      collapsed: false,
      createdAt: Date.now()
    }
    this.groups.push(group)
    for (const tab of members) tab.patch({ groupId: group.id })
    this.gatherGroup(group.id)
    this.hooks.onGroupsChanged?.(this.groups)
    this.scheduleEmit()
    return group.id
  }

  updateGroup(id: string, patch: { name?: string; color?: WorkspaceColor; collapsed?: boolean }): void {
    const group = this.groups.find((g) => g.id === id)
    if (!group) return
    if (patch.name !== undefined) group.name = patch.name
    if (patch.color !== undefined) group.color = patch.color
    if (patch.collapsed !== undefined) group.collapsed = patch.collapsed
    this.hooks.onGroupsChanged?.(this.groups)
    this.scheduleEmit()
  }

  /**
   * Removes the group. **Never removes its tabs** — they become loose.
   *
   * A group is a label over tabs that already exist, so deleting the label
   * cannot delete the things it labelled. "Close all tabs in this group" is a
   * separate, explicitly-worded action.
   */
  deleteGroup(id: string): void {
    this.groups = this.groups.filter((g) => g.id !== id)
    for (const tab of this.tabs) {
      if (tab.snapshot.groupId === id) tab.patch({ groupId: null })
    }
    this.hooks.onGroupsChanged?.(this.groups)
    this.scheduleEmit()
  }

  /** Moves one tab into a group, or out of every group with null. */
  setTabGroup(tabId: string, groupId: string | null): void {
    const tab = this.findById(tabId)
    if (!tab) return
    if (groupId !== null) {
      const group = this.groups.find((g) => g.id === groupId)
      if (!group || group.workspaceId !== tab.snapshot.workspaceId) return
    }
    tab.patch({ groupId })
    if (groupId) this.gatherGroup(groupId)
    this.hooks.onGroupsChanged?.(this.groups)
    this.scheduleEmit()
  }

  /**
   * Closes every tab in a group, then the group.
   *
   * Separate from `deleteGroup` and worded as what it does, because the two are
   * one careless click apart and only one of them is recoverable.
   */
  closeGroup(id: string): void {
    for (const tab of this.tabs.filter((t) => t.snapshot.groupId === id)) this.close(tab.id)
    this.deleteGroup(id)
  }

  /**
   * Pulls a group's tabs into one contiguous run.
   *
   * A group drawn as a coloured band around tabs scattered through the strip
   * would be a lie about what is next to what, so membership implies adjacency.
   * The run lands where the group's first member already was, so grouping does
   * not also reshuffle the strip.
   */
  private gatherGroup(groupId: string): void {
    const members = this.tabs.filter((t) => t.snapshot.groupId === groupId)
    if (members.length < 2) return

    const anchor = this.tabs.indexOf(members[0]!)
    const rest = this.tabs.filter((t) => t.snapshot.groupId !== groupId)
    // Count how many non-members precede the anchor; that is where the run goes.
    const insertAt = rest.findIndex((t) => this.tabs.indexOf(t) > anchor)
    const at = insertAt === -1 ? rest.length : insertAt

    this.tabs.length = 0
    this.tabs.push(...rest.slice(0, at), ...members, ...rest.slice(at))
  }

  /**
   * The bounds of the views actually on the window, read back from the views.
   *
   * For verification only. It deliberately asks the `WebContentsView`s rather
   * than returning what `layoutPanes` intended, because the whole failure mode
   * worth catching is intent and reality disagreeing — a pane positioned
   * off-screen or at zero width raises no error anywhere.
   */
  paneBoundsForProbe(): { primary: Rectangle | null; secondary: Rectangle | null } {
    return {
      primary: this.attachedView?.getBounds() ?? null,
      secondary: this.attachedSecondary?.getBounds() ?? null
    }
  }

  private detachSecondary(): void {
    if (!this.attachedSecondary) return
    this.window.contentView.removeChildView(this.attachedSecondary)
    this.attachedSecondary = null
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
    // The second pane goes with it. A split whose first pane is the new tab
    // page or a hibernation placeholder would leave a page floating beside a
    // chrome-drawn screen, attributed to a tab that is not showing.
    this.detachSecondary()
    if (!this.attachedView) return
    this.window.contentView.removeChildView(this.attachedView)
    this.attachedView = null
  }

  private destroyView(tab: Tab): void {
    const view = tab.view
    if (!view) return
    if (view === this.attachedSecondary) this.detachSecondary()
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
