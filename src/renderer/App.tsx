import { useEffect } from 'react'
import { NEW_TAB_URL, isInternalUrl } from '@shared/types/tab'
import {
  CHROME_HEIGHT,
  TITLE_BAR_HEIGHT,
  TOOLBAR_HEIGHT,
  WINDOW_CONTROLS_WIDTH
} from '@shared/constants'
import { FindBar, FIND_BAR_HEIGHT } from './features/find/FindBar'
import { useBrowserStore } from './stores/browserStore'
import { TabStrip } from './features/tabs/TabStrip'
import { Toolbar } from './features/omnibox/Toolbar'
import { NewTabPage } from './features/newtab/NewTabPage'
import { SidePanel } from './features/panels/SidePanel'
import { WorkspaceRail } from './features/workspaces/WorkspaceRail'
import { Icon } from './components/Icon'

/**
 * Browser chrome.
 *
 * This document spans the whole window. The region below the toolbar is the
 * "content hole": when the active tab has a live page, a native `WebContentsView`
 * is composited over that region and whatever is rendered here is hidden. When
 * the tab is an internal page or has crashed, no view is attached and this
 * document shows through — which is how the new tab page and the sad-tab screen
 * are drawn without any page of their own.
 */
export function App(): React.JSX.Element {
  const hydrate = useBrowserStore((s) => s.hydrate)
  const activeTab = useBrowserStore((s) => s.activeTab())
  const setPanel = useBrowserStore((s) => s.setPanel)
  const togglePanel = useBrowserStore((s) => s.togglePanel)
  const requestOmniboxFocus = useBrowserStore((s) => s.requestOmniboxFocus)
  const refreshHistory = useBrowserStore((s) => s.refreshHistory)
  const openFind = useBrowserStore((s) => s.openFind)
  const findOpen = useBrowserStore((s) => s.findOpen)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The chrome grows when the find bar opens, so the native page view must inset
  // by the same amount — otherwise the bar would be drawn over the page it is
  // searching, and the page would be hidden underneath it.
  useEffect(() => {
    void window.browser.invoke('layout:setChromeHeight', {
      height: CHROME_HEIGHT + (findOpen ? FIND_BAR_HEIGHT : 0)
    })
  }, [findOpen])

  // Menu accelerators arrive here because a native view — usually the page —
  // holds keyboard focus, so the chrome document never sees the keystroke.
  useEffect(() => {
    return window.browser.on('ui:command', ({ command }) => {
      switch (command) {
        case 'focus-omnibox':
          requestOmniboxFocus()
          break
        case 'open-history':
          togglePanel('history')
          void refreshHistory()
          break
        case 'open-bookmarks':
          togglePanel('bookmarks')
          break
        case 'open-downloads':
          togglePanel('downloads')
          break
        case 'open-settings':
          togglePanel('settings')
          break
        case 'open-performance':
          togglePanel('performance')
          break
        case 'open-find':
          openFind()
          break
        case 'open-permissions':
          togglePanel('permissions')
          break
        case 'open-timemachine':
          togglePanel('timemachine')
          break
        case 'open-memory':
          togglePanel('memory')
          break
        case 'open-ai':
          togglePanel('ai')
          break
        case 'close-panel':
          setPanel('none')
          break
        case 'bookmark-current-tab':
          void bookmarkCurrentTab()
          break
      }
    })
  }, [togglePanel, setPanel, requestOmniboxFocus, refreshHistory])

  const showNewTab = activeTab?.url === NEW_TAB_URL
  const crashed = activeTab?.status === 'crashed'
  // A hibernated tab has no view attached, so the chrome shows through the
  // content hole — the same mechanism that renders the new tab page.
  const hibernated = activeTab?.status === 'hibernated'

  return (
    // No opaque background: the window's acrylic is the backdrop, and each row
    // below adds its own translucent layer over it.
    <div className="flex h-full flex-col">
      {/*
        Row 1 is the title bar. The window has no OS title bar, so this strip
        carries the drag region and reserves space on the right for the native
        minimise/maximise/close buttons Windows draws over it.
      */}
      <div
        className="app-drag glass flex shrink-0 items-stretch"
        style={{ height: TITLE_BAR_HEIGHT, paddingRight: WINDOW_CONTROLS_WIDTH }}
      >
        <TabStrip />
      </div>

      {/* Row 2: workspace rail on the left, toolbar and content to its right —
          matching the native page view's inset (WORKSPACE_RAIL_WIDTH). */}
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="glass glass-divide-b relative shrink-0"
            style={{ height: TOOLBAR_HEIGHT }}
          >
            <Toolbar />
            {/*
              Loading indicator. Chromium reports no load percentage, so an
              indeterminate sweep is the honest form — a fake percentage that
              creeps to 90% and waits is worse than none.
            */}
            {activeTab?.isLoading && (
              <div className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
                <div className="h-full w-1/3 animate-[loading_1.1s_ease-in-out_infinite] bg-[var(--color-accent)]" />
              </div>
            )}
          </div>
          <FindBar />

          <div className="flex min-h-0 flex-1">
            <main className="min-w-0 flex-1">
              {crashed ? (
                <SadTab />
              ) : hibernated ? (
                <HibernatedTab />
              ) : showNewTab ? (
                <NewTabPage />
              ) : null}
            </main>
            <SidePanel />
          </div>
        </div>
      </div>
    </div>
  )
}

async function bookmarkCurrentTab(): Promise<void> {
  const { activeTab, bookmarks } = useBrowserStore.getState()
  const tab = activeTab()
  if (!tab || isInternalUrl(tab.url)) return

  const existing = bookmarks.find((b) => !b.isFolder && b.url === tab.url)
  if (existing) {
    await window.browser.invoke('bookmarks:delete', { id: existing.id })
    return
  }
  await window.browser.invoke('bookmarks:create', {
    url: tab.url,
    title: tab.title || tab.url,
    faviconUrl: tab.faviconUrl,
    parentId: null,
    isFolder: false
  })
}

/**
 * Placeholder for a hibernated tab.
 *
 * Activating one normally rebuilds it automatically, so this is only seen if the
 * rebuild is still in flight. It states plainly what hibernation cost — page
 * state is gone, navigation history is not — rather than implying the tab was
 * merely paused.
 */
function HibernatedTab(): React.JSX.Element {
  const activeTab = useBrowserStore((s) => s.activeTab())

  return (
    <div className="glass-page flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Icon name="clock" size={28} className="text-violet-400" />
      <div>
        <h2 className="text-lg font-semibold">{activeTab?.title || 'This tab is asleep'}</h2>
        <p className="mt-1 max-w-md text-sm text-[var(--color-text-muted)]">
          Its memory was released to speed up the rest of the browser. Reloading restores the page
          and your back/forward history — anything typed into the page is gone.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (activeTab) {
            void window.browser.invoke('performance:restore', { tabId: activeTab.id })
          }
        }}
        className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-2 text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        Wake this tab
      </button>
    </div>
  )
}

/**
 * Shown when a tab's renderer process dies.
 *
 * A crashed tab keeps its place in the strip and its URL, so Reload rebuilds the
 * view and navigates back — the alternative, a silently blank page, gives the
 * user nothing to act on.
 */
function SadTab(): React.JSX.Element {
  const activeTab = useBrowserStore((s) => s.activeTab())

  return (
    <div className="glass-page flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Icon name="warning" size={32} className="text-[var(--color-bad)]" />
      <div>
        <h2 className="text-lg font-semibold">This tab stopped working</h2>
        <p className="mt-1 max-w-md text-sm text-[var(--color-text-muted)]">
          {activeTab?.error?.description ?? 'The page process ended unexpectedly.'} Reloading starts
          it again — anything you had typed on the page is gone.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (activeTab) {
            void window.browser.invoke('nav:reload', { tabId: activeTab.id, ignoreCache: false })
          }
        }}
        className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-2 text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        Reload page
      </button>
    </div>
  )
}
