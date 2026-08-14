import { create } from 'zustand'
import type { Tab, TabsSnapshot } from '@shared/types/tab'
import type { Settings } from '@shared/types/settings'
import type { Bookmark, DownloadItem, HistoryEntry } from '@shared/types/browsing'
import { DEFAULT_WORKSPACE_ID, type Workspace } from '@shared/types/workspace'

export type PanelId =
  | 'none'
  | 'history'
  | 'bookmarks'
  | 'downloads'
  | 'settings'
  | 'performance'

interface BrowserState {
  tabs: Tab[]
  activeTabId: string | null
  settings: Settings | null
  downloads: DownloadItem[]
  bookmarks: Bookmark[]
  history: HistoryEntry[]
  workspaces: Workspace[]
  activeWorkspaceId: string
  /** Workspace id being edited, 'new' for the create form, or null when closed. */
  workspaceEditorId: string | 'new' | null
  panel: PanelId
  findOpen: boolean
  findQuery: string
  /**
   * Incremented to ask the omnibox to focus and select itself.
   *
   * A counter rather than a boolean because Ctrl+L pressed twice in a row must
   * re-focus both times; a boolean would already be true and the effect would
   * not re-run.
   */
  focusOmniboxToken: number

  activeTab: () => Tab | null
  activeWorkspace: () => Workspace | null
  setPanel: (panel: PanelId) => void
  togglePanel: (panel: Exclude<PanelId, 'none'>) => void
  setWorkspaceEditor: (id: string | 'new' | null) => void
  openFind: () => void
  closeFind: () => void
  setFindQuery: (query: string) => void
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
  settings: null,
  downloads: [],
  bookmarks: [],
  history: [],
  workspaces: [],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  workspaceEditorId: null,
  panel: 'none',
  findOpen: false,
  findQuery: '',
  focusOmniboxToken: 0,

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

  requestOmniboxFocus: () => set((state) => ({ focusOmniboxToken: state.focusOmniboxToken + 1 })),

  applySnapshot: (snapshot) => set({ tabs: snapshot.tabs, activeTabId: snapshot.activeTabId }),

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
    const [tabs, settings, workspaces] = await Promise.all([
      window.browser.invoke('tabs:list', undefined),
      window.browser.invoke('settings:getAll', undefined),
      window.browser.invoke('workspaces:list', undefined)
    ])
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
