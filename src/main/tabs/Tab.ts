import type { WebContents, WebContentsView } from 'electron'
import { type Tab as TabSnapshot, isInternalUrl, NEW_TAB_URL } from '@shared/types/tab'

let counter = 0
function nextTabId(): string {
  counter += 1
  return `tab-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** Navigation history preserved across hibernation. */
export interface SavedNavigation {
  entries: Electron.NavigationEntry[]
  index: number
}

/**
 * One tab: a serialisable model plus an **optional** live `WebContentsView`.
 *
 * The optionality is the single most important design decision in Phase 1. A tab
 * whose view is null is a completely normal tab — it has a URL, a title, a
 * favicon and a place in the strip — it simply is not currently rendering. That
 * is exactly what Phase 3's HIBERNATED state needs, so hibernation becomes
 * "destroy the view and keep the model" rather than a refactor of everything
 * that assumes a tab owns a renderer.
 *
 * Internal pages (the new tab page) also have no view: they are drawn by the
 * chrome document in the content hole, which is why they need no renderer and no
 * custom protocol.
 */
export class Tab {
  readonly id: string
  private state: TabSnapshot
  private viewRef: WebContentsView | null = null
  private savedNavigation: SavedNavigation | null = null

  /**
   * Reported by the content preload. Drives the `unsaved-form-input` guard —
   * hibernating a tab destroys its renderer, so anything typed but not submitted
   * is gone. Untrusted: a page can lie, but only about itself.
   */
  private unsavedInput = false
  /**
   * Observed when Chromium tells us a beforeunload handler tried to block.
   *
   * There is no API to ask whether a page has registered one, and the preload
   * cannot see the page's own `window` object across context isolation. So this
   * is set reactively rather than predicted — see the note on the
   * `has-beforeunload` blocker.
   */
  private beforeUnloadObserved = false
  /** Working set at the moment of hibernation, for measured savings reporting. */
  private rssBeforeHibernate: number | null = null
  /** Scroll offset awaiting reapplication after a snapshot restore. */
  private pendingScrollY = 0

  constructor(init: { workspaceId: string; url?: string; id?: string }) {
    this.id = init.id ?? nextTabId()
    const now = Date.now()
    this.state = {
      id: this.id,
      workspaceId: init.workspaceId,
      url: init.url ?? NEW_TAB_URL,
      title: '',
      faviconUrl: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isPinned: false,
      isAudible: false,
      isMuted: false,
      isProtected: false,
      isFrozen: false,
      zoomLevel: 0,
      findResult: null,
      status: 'live',
      error: null,
      lastActiveAt: now,
      createdAt: now
    }
  }

  get snapshot(): TabSnapshot {
    return this.state
  }

  get view(): WebContentsView | null {
    return this.viewRef
  }

  get contents(): WebContents | null {
    const view = this.viewRef
    if (!view || view.webContents.isDestroyed()) return null
    return view.webContents
  }

  /** True when this tab's URL requires a real renderer. */
  get needsView(): boolean {
    return !isInternalUrl(this.state.url)
  }

  patch(update: Partial<TabSnapshot>): void {
    this.state = { ...this.state, ...update }
  }

  setHasUnsavedInput(value: boolean): void {
    this.unsavedInput = value
  }

  get hasUnsavedInput(): boolean {
    return this.unsavedInput
  }

  markBeforeUnloadObserved(): void {
    this.beforeUnloadObserved = true
  }

  get hasBeforeUnload(): boolean {
    return this.beforeUnloadObserved
  }

  /** Bytes freed by hibernating this tab, or null if it was never hibernated. */
  get measuredSavingsBytes(): number | null {
    return this.state.status === 'hibernated' ? this.rssBeforeHibernate : null
  }

  recordRssBeforeHibernate(bytes: number | null): void {
    this.rssBeforeHibernate = bytes
  }

  touch(): void {
    this.patch({ lastActiveAt: Date.now() })
  }

  attachView(view: WebContentsView): void {
    this.viewRef = view
    this.patch({ status: 'live' })
  }

  /**
   * Captures navigation history and drops the view.
   *
   * The saved entries are what make a restored tab keep its Back button —
   * restoring only the URL would silently discard the user's trail. Reading them
   * has to happen *before* the contents are destroyed, which is why this is one
   * operation rather than a getter plus a separate teardown.
   */
  detachView(): SavedNavigation | null {
    const contents = this.contents
    if (contents) {
      try {
        this.savedNavigation = {
          entries: contents.navigationHistory.getAllEntries(),
          index: contents.navigationHistory.getActiveIndex()
        }
      } catch {
        this.savedNavigation = null
      }
    }
    this.viewRef = null
    // A destroyed renderer cannot still be holding typed text; clearing this
    // prevents a stale flag from blocking a later, legitimate hibernation.
    this.unsavedInput = false
    return this.savedNavigation
  }

  takeSavedNavigation(): SavedNavigation | null {
    const saved = this.savedNavigation
    this.savedNavigation = null
    return saved
  }

  /**
   * Seeds a tab restored from a snapshot with the history it had.
   *
   * Reuses the same field hibernation uses, so a restored tab and a woken tab
   * take one identical code path rather than two that can drift apart.
   */
  seedFromSnapshot(entries: SavedNavigation['entries'], index: number, scrollY: number): void {
    if (entries.length > 0) {
      this.savedNavigation = { entries, index: Math.max(0, Math.min(index, entries.length - 1)) }
    }
    this.pendingScrollY = scrollY
  }

  /** Scroll offset to reapply once the page has loaded. Consumed on read. */
  takePendingScrollY(): number {
    const value = this.pendingScrollY
    this.pendingScrollY = 0
    return value
  }
}
