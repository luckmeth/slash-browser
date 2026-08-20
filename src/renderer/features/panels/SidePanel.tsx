import { useEffect } from 'react'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { HistoryPanel } from './HistoryPanel'
import { ReadingListPanel } from './ReadingListPanel'
import { BookmarksPanel } from './BookmarksPanel'
import { DownloadsCenter } from '../downloads/DownloadsCenter'
import { GuardianPanel } from '../downloads/GuardianPanel'
import { TabBrainPanel } from '../tabbrain/TabBrainPanel'
import { PageInsightPanel } from '../insight/PageInsightPanel'
import { RedirectXRayPanel } from '../shield/RedirectXRayPanel'
import { WatchPanel } from '../watch/WatchPanel'
import { MissionPanel } from '../missions/MissionPanel'
import { AiHubPanel } from '../ai/AiHubPanel'
import { DownloadsPanel } from './DownloadsPanel'
import { SettingsPanel } from './SettingsPanel'
import { WorkspaceEditor } from '../workspaces/WorkspaceEditor'
import { PerformancePanel } from '../performance/PerformancePanel'
import { PermissionsPanel } from '../permissions/PermissionsPanel'
import { TimeMachinePanel } from '../timemachine/TimeMachinePanel'
import { MemoryPanel } from '../memory/MemoryPanel'
import { AiPanel } from '../ai/AiPanel'

export const SIDE_PANEL_WIDTH = 380

const TITLES = {
  history: 'History',
  bookmarks: 'Bookmarks',
  reading: 'Reading list',
  downloads: 'Downloads',
  settings: 'Settings',
  performance: 'Performance',
  permissions: 'Permissions',
  timemachine: 'Restore points',
  memory: 'Browsing memory',
  tabbrain: 'Tab Brain',
  insight: 'Page Insight',
  redirects: 'Redirect X-Ray',
  mission: 'Mission Mode',
  ai: 'Assistant'
} as const

/**
 * The right-hand panel.
 *
 * It insets the page view rather than floating above it — see
 * `ViewLayoutManager.setRightPanelWidth`. The width is reported to main whenever
 * the panel opens or closes so the native page view resizes in step; without
 * that the panel would be drawn over a page that still believed it owned the
 * full width, and the page would simply be hidden underneath.
 *
 * The workspace editor shares this slot, so only one thing ever occupies the
 * strip.
 */
export function SidePanel(): React.JSX.Element | null {
  const panel = useBrowserStore((s) => s.panel)
  const workspaceEditorId = useBrowserStore((s) => s.workspaceEditorId)
  const setPanel = useBrowserStore((s) => s.setPanel)
  const setWorkspaceEditor = useBrowserStore((s) => s.setWorkspaceEditor)
  const workspaces = useBrowserStore((s) => s.workspaces)

  const showingEditor = workspaceEditorId !== null
  const open = showingEditor || panel !== 'none'

  useEffect(() => {
    void window.browser.invoke('layout:setRightPanelWidth', {
      width: open ? SIDE_PANEL_WIDTH : 0
    })
  }, [open])

  if (!open) return null

  const title = showingEditor
    ? workspaceEditorId === 'new'
      ? 'New workspace'
      : (workspaces.find((w) => w.id === workspaceEditorId)?.name ?? 'Workspace')
    : TITLES[panel as keyof typeof TITLES]

  return (
    <aside
      style={{ width: SIDE_PANEL_WIDTH }}
      className="glass-page flex h-full shrink-0 flex-col border-l border-[var(--glass-edge)]"
      aria-label={title}
    >
      <header className="glass-divide-b flex items-center justify-between px-4 py-3">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => (showingEditor ? setWorkspaceEditor(null) : setPanel('none'))}
          className="cursor-pointer rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)]"
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showingEditor ? (
          <WorkspaceEditor />
        ) : (
          <>
            {panel === 'history' && <HistoryPanel />}
            {panel === 'bookmarks' && <BookmarksPanel />}
            {panel === 'reading' && <ReadingListPanel />}
            {panel === 'downloads' && (
              <>
                {/* Electron-initiated downloads above, engine-managed below.
                    Two systems, so the panel says which is which rather than
                    mixing them into one list where pause behaves differently
                    depending on an invisible distinction. */}
                <GuardianPanel />
                <DownloadsPanel />
                <div className="border-t border-[var(--color-border-subtle)] pt-2">
                  <p className="px-3 pb-1 text-[10px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
                    Managed downloads
                  </p>
                  <DownloadsCenter />
                </div>
              </>
            )}
            {panel === 'settings' && <SettingsPanel />}
            {panel === 'performance' && <PerformancePanel />}
            {panel === 'permissions' && <PermissionsPanel />}
            {panel === 'timemachine' && (
              <>
                {/* Watched pages above restore points: "has this changed" is the
                    question people open the Time Machine for far more often than
                    "put my session back". */}
                <WatchPanel />
                <div className="border-t border-[var(--color-border-subtle)]">
                  <TimeMachinePanel />
                </div>
              </>
            )}
            {panel === 'memory' && <MemoryPanel />}
            {panel === 'tabbrain' && <TabBrainPanel />}
            {panel === 'insight' && <PageInsightPanel />}
            {panel === 'redirects' && <RedirectXRayPanel />}
            {panel === 'mission' && <MissionPanel />}
            {panel === 'ai' && (
              <>
                {/* Providers first: the assistant below is unusable until one is
                    connected, so the connection step belongs above it. */}
                <AiHubPanel />
                <div className="border-t border-[var(--color-border-subtle)]">
                  <AiPanel />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
