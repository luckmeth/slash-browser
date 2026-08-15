import { useEffect } from 'react'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { HistoryPanel } from './HistoryPanel'
import { BookmarksPanel } from './BookmarksPanel'
import { DownloadsPanel } from './DownloadsPanel'
import { SettingsPanel } from './SettingsPanel'
import { WorkspaceEditor } from '../workspaces/WorkspaceEditor'
import { PerformancePanel } from '../performance/PerformancePanel'
import { PermissionsPanel } from '../permissions/PermissionsPanel'
import { TimeMachinePanel } from '../timemachine/TimeMachinePanel'
import { MemoryPanel } from '../memory/MemoryPanel'

export const SIDE_PANEL_WIDTH = 380

const TITLES = {
  history: 'History',
  bookmarks: 'Bookmarks',
  downloads: 'Downloads',
  settings: 'Settings',
  performance: 'Performance',
  permissions: 'Permissions',
  timemachine: 'Restore points',
  memory: 'Browsing memory'
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
      className="flex h-full shrink-0 flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
      aria-label={title}
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
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
            {panel === 'downloads' && <DownloadsPanel />}
            {panel === 'settings' && <SettingsPanel />}
            {panel === 'performance' && <PerformancePanel />}
            {panel === 'permissions' && <PermissionsPanel />}
            {panel === 'timemachine' && <TimeMachinePanel />}
            {panel === 'memory' && <MemoryPanel />}
          </>
        )}
      </div>
    </aside>
  )
}
