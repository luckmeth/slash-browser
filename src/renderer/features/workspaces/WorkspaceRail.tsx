import { useState } from 'react'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { COLOR_CLASSES } from './workspaceColors'

/**
 * The workspace switcher, as a row across the top of the chrome.
 *
 * It used to be a rail down the left edge, and the change is not cosmetic: a
 * rail costs 56px of **page width on every page**, permanently, for a control
 * used a handful of times a day — and unlike a side panel it could not be
 * dismissed. As a row it costs height once, and `setSidebarWidth` now insets the
 * page by nothing at all unless the tab strip is vertical.
 *
 * The switching, drag-to-move and isolation-warning behaviour is unchanged.
 * This is deliberately the same component rather than a second one: moving a tab
 * between workspaces can sign you out of it, and that confirmation is not
 * something to have two copies of.
 */
export function WorkspaceRail(): React.JSX.Element {
  const workspaces = useBrowserStore((s) => s.workspaces)
  const activeWorkspaceId = useBrowserStore((s) => s.activeWorkspaceId)
  const setWorkspaceEditor = useBrowserStore((s) => s.setWorkspaceEditor)
  const tabs = useBrowserStore((s) => s.tabs)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  return (
    <nav
      aria-label="Workspaces"
      className="app-no-drag flex h-full items-center gap-1 px-2"
    >
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeWorkspaceId
        const colors = COLOR_CLASSES[workspace.color]
        const tabCount = isActive ? tabs.length : null

        return (
          <button
            key={workspace.id}
            type="button"
            title={`${workspace.name}${workspace.isolated ? ' (isolated)' : ''}`}
            aria-label={workspace.name}
            aria-current={isActive}
            onClick={() => void window.browser.invoke('workspaces:activate', { id: workspace.id })}
            onContextMenu={(event) => {
              event.preventDefault()
              setWorkspaceEditor(workspace.id)
            }}
            // Dropping a tab here moves it. The confirmation for crossing an
            // isolation boundary is raised by the drop handler, not here.
            onDragOver={(event) => {
              event.preventDefault()
              setDragOverId(workspace.id)
            }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(event) => {
              event.preventDefault()
              setDragOverId(null)
              const tabId = event.dataTransfer.getData('text/tab-id')
              if (tabId) void moveTab(tabId, workspace.id)
            }}
            className={[
              'relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm transition',
              isActive ? `${colors.tint} ring-1 ${colors.ring}` : 'hover:bg-white/5',
              dragOverId === workspace.id ? 'ring-2 ring-[var(--color-accent)]' : ''
            ].join(' ')}
          >
            <Icon name={workspace.icon} size={15} />
            {/*
              The name, which the rail never had room for. A row does, and a
              workspace switcher whose entries are unlabelled icons is one you
              have to learn by position — the reason the rail needed a tooltip
              to be usable at all.
            */}
            <span className="max-w-[10rem] truncate text-xs">{workspace.name}</span>

            {/* An isolated workspace is marked, because "my logins are separate
                here" is the one property a user must be able to see at a glance. */}
            {workspace.isolated && (
              <span
                className="text-[var(--color-text-muted)]"
                title="Isolated — separate cookies and storage"
              >
                <Icon name="lock" size={10} />
              </span>
            )}

            {tabCount !== null && tabCount > 0 && (
              <span className="sr-only">{tabCount} tabs</span>
            )}
          </button>
        )
      })}

      <button
        type="button"
        title="New workspace"
        aria-label="New workspace"
        onClick={() => setWorkspaceEditor('new')}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="plus" size={14} />
      </button>

      <button
        type="button"
        title="Manage workspaces"
        aria-label="Manage workspaces"
        onClick={() => setWorkspaceEditor(activeWorkspaceId)}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="settings" size={14} />
      </button>
    </nav>
  )
}

/**
 * Moves a tab between workspaces, confirming first when the move crosses an
 * isolation boundary.
 *
 * The confirmation is not a formality: the target workspace has its own cookie
 * partition, so the page genuinely reloads signed out and there is no way to
 * carry the session across. Better to say so before than to surprise someone
 * out of a half-finished form.
 */
async function moveTab(tabId: string, workspaceId: string): Promise<void> {
  const { tabs, workspaces } = useBrowserStore.getState()
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab || tab.workspaceId === workspaceId) return

  const from = workspaces.find((w) => w.id === tab.workspaceId)
  const to = workspaces.find((w) => w.id === workspaceId)
  const crosses = (from?.isolated ?? false) !== (to?.isolated ?? false) || (to?.isolated ?? false)

  if (crosses) {
    const confirmed = window.confirm(
      `Move this tab to "${to?.name}"?\n\n` +
        `That workspace keeps its own cookies and storage, so the page will reload ` +
        `and you will be signed out of it there. Anything unsaved on the page will be lost.`
    )
    if (!confirmed) return
  }

  await window.browser.invoke('tabs:moveToWorkspace', { tabId, workspaceId })
}
