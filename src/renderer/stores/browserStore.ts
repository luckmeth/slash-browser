import { create } from 'zustand'
import { SETTINGS_URL } from '@shared/types/tab'
import type { Tab, TabsSnapshot } from '@shared/types/tab'
import type { TabGroup } from '@shared/types/tabGroup'
import type { Settings } from '@shared/types/settings'
import type { Bookmark, DownloadItem, HistoryEntry } from '@shared/types/browsing'
import { DEFAULT_WORKSPACE_ID, type Workspace } from '@shared/types/workspace'

export type PanelId =
  | 'none'
  | 'history'
  | 'bookmarks'
  | 'reading'
  | 'downloads'
  | 'settings'
  | 'performance'
  | 'permissions'
  | 'timemachine'
  | 'memory'
  | 'tabbrain'
  | 'insight'
  | 'redirects'
  | 'mission'
  | 'ai'

interface BrowserState {
  tabs: Tab[]
  activeTabId: string | null
  /**
   * Split view, straight from the snapshot.
   *
   * The geometry is the main process's own pane arithmetic, not a copy of it —
   * the panes are native views it positions, so the drag handle has to be told
   * where the seam is rather than guessing.
   */
  /** Coloured runs of tabs in the active workspace. */
  groups: TabGroup[]
  split: Pick<
    TabsSnapshot,
    'splitTabId' | 'splitFraction' | 'splitOrientation' | 'canSplit' | 'splitGeometry'
  >
  settings: Settings | null
  downloads: DownloadItem[]
  bookmarks: Bookmark[]
  history: HistoryEntry[]
  isPrivate: boolean
  workspaces: Workspace[]
  activeWorkspaceId: string
  /** Workspace id being edited, 'new' for the create form, or null when closed. */
  workspaceEditorId: string | 'new' | null
  panel: PanelId
  findOpen: boolean
  findQuery: string
  /**
   * Host whose hand-off notice the user dismissed.
   *
   * Held here rather than inside the notice because the notice occupies real
   * layout space — the page view has to inset by its height — so App needs to
   * know whether it is showing.
   */
  handoffDismissedHost: string | null
  /**
   * Incremented to ask the omnibox to focus and select itself.
   *
   * A counter rather than a boolean because Ctrl+L pressed twice in a row must
   * re-focus both times; a boolean would already be true and the effect would
   * not re-run.
   */
  focusOmniboxToken: number
  /**
   * Downloadable files the active tab has been seen fetching.
   *
   * Drives one toolbar button, which is only shown when there is something to
   * download. A permanent button that is usually useless teaches people to
   * ignore it, and this one is only worth anything when it is a surprise.
   */
  detectedMedia: number

  activeTab: () => Tab | null
  activeWorkspace: () => Workspace | null
  setPanel: (panel: PanelId) => void
  setDetectedMedia: (count: number) => void
  togglePanel: (panel: Exclude<PanelId, 'none'>) => void
  /**
   * Opens settings as a page, reusing an existing settings tab if one is open.
   *
   * A page rather than the 380px side panel: seventeen groups in a narrow
   * scroll is a list, not a settings screen. Reusing the tab matters because
   * every entry point leads here — the toolbar, the palette, Ctrl+, and the
   * sponsored tile's "turn off" — and each opening its own tab would litter the
   * strip.
   */
  openSettings: (filter?: string) => void
  /**
   * What the settings screen should open filtered to, consumed once.
   *
   * Set when somebody reaches Settings by searching for a setting rather than
   * by opening the screen. Cleared by the screen on mount, so returning to an
   * already-open Settings tab later does not silently re-apply a filter the
   * user has since cleared.
   */
  settingsFilter: string | null
  takeSettingsFilter: () => string | null
  setWorkspaceEditor: (id: string | 'new' | null) => void
  openFind: () => void
  closeFind: () => void
  setFindQuery: (query: string) => void
  dismissHandoff: (host: string | null) => void
  requestOmniboxFocus: () => void
  applySnapshot: (snapshot: TabsSnapshot) => void
  refreshHistory: (query?: string) => Promise<void>
  refreshBookmarks: () => Promise<void>
  refreshDownloads: () => Promise<void>
  hydrate: () => Promise<void>
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  groups: [],
  split: {
    splitTabId: null,
    splitFraction: 0.5,
    splitOrientation: 'vertical',
    canSplit: true,
    splitGeometry: null
  },
  settings: null,
  downloads: [],
  bookmarks: [],
  history: [],
  isPrivate: false,
  workspaces: [],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  workspaceEditorId: null,
  panel: 'none',
  findOpen: false,
  findQuery: '',
  handoffDismissedHost: null,
  focusOmniboxToken: 0,
  detectedMedia: 0,

  activeTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId) ?? null
  },

  activeWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get()
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? null
  },

  // The workspace editor and the side panels share the same slot, so opening one
  // closes the other rather than stacking two things in the same strip.
  setPanel: (panel) => set({ panel, workspaceEditorId: null }),
  setDetectedMedia: (detectedMedia) => set({ detectedMedia }),

  settingsFilter: null,
  takeSettingsFilter: () => {
    const filter = get().settingsFilter
    if (filter !== null) set({ settingsFilter: null })
    return filter
  },

  openSettings: (filter?: string) => {
    if (filter !== undefined) set({ settingsFilter: filter })
    const existing = get().tabs.find((tab) => tab.url === SETTINGS_URL)
    if (existing) {
      void window.browser.invoke('tabs:activate', { tabId: existing.id })
      return
    }
    void window.browser.invoke('tabs:create', { url: SETTINGS_URL, background: false })
  },

  togglePanel: (panel) =>
    set((state) => ({
      panel: state.panel === panel ? 'none' : panel,
      workspaceEditorId: null
    })),

  setWorkspaceEditor: (workspaceEditorId) => set({ workspaceEditorId, panel: 'none' }),

  openFind: () => set({ findOpen: true }),

  closeFind: () => {
    // Clear the highlight in the page too, or the last search stays marked up
    // after the bar is gone.
    const { activeTabId } = get()
    if (activeTabId) {
      void window.browser.invoke('view:stopFind', { tabId: activeTabId, keepSelection: false })
    }
    set({ findOpen: false, findQuery: '' })
  },

  setFindQuery: (findQuery) => set({ findQuery }),

  dismissHandoff: (handoffDismissedHost) => set({ handoffDismissedHost }),

  requestOmniboxFocus: () => set((state) => ({ focusOmniboxToken: state.focusOmniboxToken + 1 })),

  applySnapshot: (snapshot) =>
    set({
      tabs: snapshot.tabs,
      activeTabId: snapshot.activeTabId,
      groups: snapshot.groups,
      split: {
        splitTabId: snapshot.splitTabId,
        splitFraction: snapshot.splitFraction,
        splitOrientation: snapshot.splitOrientation,
        canSplit: snapshot.canSplit,
        splitGeometry: snapshot.splitGeometry
      }
    }),

  refreshHistory: async (query = '') => {
    const result = await window.browser.invoke('history:search', {
      query,
      limit: 200,
      offset: 0
    })
    if (result.ok) set({ history: result.value })
  },

  refreshBookmarks: async () => {
    const result = await window.browser.invoke('bookmarks:list', undefined)
    if (result.ok) set({ bookmarks: result.value })
  },

  refreshDownloads: async () => {
    const result = await window.browser.invoke('downloads:list', undefined)
    if (result.ok) set({ downloads: result.value })
  },

  /**
   * Initial load plus event subscriptions.
   *
   * Main pushes a snapshot on every change, so after this the store is only ever
   * written from events — the UI never polls and two windows cannot disagree
   * about which tab is active.
   */
  hydrate: async () => {
    const [tabs, settings, workspaces, info] = await Promise.all([
      window.browser.invoke('tabs:list', undefined),
      window.browser.invoke('settings:getAll', undefined),
      window.browser.invoke('workspaces:list', undefined),
      window.browser.invoke('app:info', undefined)
    ])
    if (info.ok) set({ isPrivate: info.value.isPrivate })
    if (tabs.ok) get().applySnapshot(tabs.value)
    if (settings.ok) set({ settings: settings.value })
    if (workspaces.ok) {
      set({
        workspaces: workspaces.value.workspaces,
        activeWorkspaceId: workspaces.value.activeWorkspaceId
      })
    }

    await Promise.all([get().refreshBookmarks(), get().refreshDownloads()])

    window.browser.on('tabs:snapshot', (snapshot) => get().applySnapshot(snapshot))
    window.browser.on('workspaces:snapshot', (snapshot) =>
      set({
        workspaces: snapshot.workspaces,
        activeWorkspaceId: snapshot.activeWorkspaceId
      })
    )
    window.browser.on('settings:changed', (next) => set({ settings: next }))
    window.browser.on('downloads:changed', (items) => set({ downloads: items }))
    window.browser.on('bookmarks:changed', (items) => set({ bookmarks: items }))
    window.browser.on('history:changed', () => {
      // Only refetch while the panel is open; otherwise every page load would
      // pull 200 rows nobody is looking at.
      if (get().panel === 'history') void get().refreshHistory()
    })
  }
}))
