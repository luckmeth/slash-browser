import { useEffect, useRef, useState } from 'react'
import type { TabGroup } from '@shared/types/tabGroup'
import { WORKSPACE_COLORS, type WorkspaceColor } from '@shared/types/workspace'
import { WORKSPACE_ACCENT_HEX } from '../workspaces/useWorkspaceTheme'

/**
 * The header of a coloured run of tabs.
 *
 * Clicking it collapses the group. Collapsing is *not* sleeping: the tabs keep
 * their views, keep loading and keep playing audio, and only the strip stops
 * drawing them. So a collapsed chip shows its tab count — a run that simply
 * vanished would read as "those tabs are gone", which is the one thing it must
 * not mean.
 */
export function TabGroupChip({
  group,
  count,
  vertical
}: {
  group: TabGroup
  count: number
  vertical: boolean
}): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(group.name)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const commit = (): void => {
    setRenaming(false)
    if (draft !== group.name) {
      void window.browser.invoke('tabs:updateGroup', { id: group.id, name: draft })
    }
  }

  return (
    <div className={`relative flex shrink-0 items-center ${vertical ? 'w-full' : ''}`}>
      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              setDraft(group.name)
              setRenaming(false)
            }
          }}
          maxLength={60}
          aria-label="Group name"
          className="h-[22px] w-24 rounded-md border border-[var(--glass-edge-strong)] bg-black/30 px-1.5 text-[11px] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() =>
            void window.browser.invoke('tabs:updateGroup', {
              id: group.id,
              collapsed: !group.collapsed
            })
          }
          onDoubleClick={() => {
            setDraft(group.name)
            setRenaming(true)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
          title={
            group.collapsed
              ? `${group.name || 'Group'} — ${count} tab${count === 1 ? '' : 's'}, still open`
              : `${group.name || 'Group'} — double-click to rename`
          }
          className="app-no-drag flex h-[22px] cursor-default items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition hover:brightness-125"
          style={{
            backgroundColor: `color-mix(in srgb, ${swatch(group.color)} 26%, transparent)`,
            color: swatch(group.color)
          }}
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: swatch(group.color) }}
          />
          {group.name || 'Group'}
          {/* Only when collapsed: otherwise the tabs themselves are the count. */}
          {group.collapsed && <span className="opacity-70">{count}</span>}
        </button>
      )}

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="glass-float absolute top-full left-0 z-50 mt-1 w-52 rounded-xl p-1.5">
            <div className="flex gap-1 p-1">
              {WORKSPACE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Colour ${color}`}
                  onClick={() => {
                    void window.browser.invoke('tabs:updateGroup', { id: group.id, color })
                    setMenuOpen(false)
                  }}
                  className={`size-4 cursor-default rounded-full transition hover:scale-110 ${
                    group.color === color ? 'ring-2 ring-white/70' : ''
                  }`}
                  style={{ backgroundColor: swatch(color) }}
                />
              ))}
            </div>
            <MenuItem
              label="Rename"
              onClick={() => {
                setMenuOpen(false)
                setDraft(group.name)
                setRenaming(true)
              }}
            />
            {/* The two destructive-looking actions, worded for what they do.
                Ungrouping keeps every tab open; only the second closes anything. */}
            <MenuItem
              label="Ungroup (keeps tabs open)"
              onClick={() => {
                setMenuOpen(false)
                void window.browser.invoke('tabs:deleteGroup', { id: group.id })
              }}
            />
            <MenuItem
              label={`Close ${count} tab${count === 1 ? '' : 's'}`}
              danger
              onClick={() => {
                setMenuOpen(false)
                void window.browser.invoke('tabs:closeGroup', { id: group.id })
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  danger
}: {
  label: string
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full cursor-default rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-white/10 ${
        danger ? 'text-[var(--color-danger)]' : ''
      }`}
    >
      {label}
    </button>
  )
}

/**
 * Group colours come from the workspace palette itself, not a copy of it, so
 * adjusting the palette moves both together.
 */
function swatch(color: WorkspaceColor): string {
  return WORKSPACE_ACCENT_HEX[color]
}
