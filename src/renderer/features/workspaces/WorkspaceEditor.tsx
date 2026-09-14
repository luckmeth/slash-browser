import { useEffect, useState } from 'react'
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_ICON,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  type WorkspaceColor,
  type WorkspaceIcon
} from '@shared/types/workspace'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { COLOR_CLASSES } from './workspaceColors'

/** Names for the icon picker — an icon button with no label is a guess. */
const ICON_LABELS: Record<WorkspaceIcon, string> = {
  wsHome: 'Home',
  wsWork: 'Work',
  wsStudy: 'Study',
  wsCode: 'Development',
  wsResearch: 'Research',
  wsTravel: 'Travel',
  wsShop: 'Shopping',
  wsMedia: 'Media',
  wsDesign: 'Design',
  wsReading: 'Reading',
  wsFinance: 'Finance',
  wsFolder: 'General'
}

/**
 * Create/edit panel for a workspace.
 *
 * Rendered in the side-panel slot so it insets the page rather than covering it,
 * for the same reason as every other panel: a CSS layer in the chrome document
 * would be drawn underneath the native page view.
 */
export function WorkspaceEditor(): React.JSX.Element | null {
  const editorId = useBrowserStore((s) => s.workspaceEditorId)
  const setWorkspaceEditor = useBrowserStore((s) => s.setWorkspaceEditor)
  const workspaces = useBrowserStore((s) => s.workspaces)

  const isNew = editorId === 'new'
  const existing = isNew ? null : workspaces.find((w) => w.id === editorId)

  const [name, setName] = useState('')
  const [icon, setIcon] = useState<WorkspaceIcon>(DEFAULT_WORKSPACE_ICON)
  const [color, setColor] = useState<WorkspaceColor>('slate')
  const [isolated, setIsolated] = useState(false)
  const [notes, setNotes] = useState('')
  /** What just happened, or why it did not. */
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setName(existing?.name ?? '')
    setIcon(existing?.icon ?? DEFAULT_WORKSPACE_ICON)
    setColor(existing?.color ?? 'slate')
    setIsolated(existing?.isolated ?? false)
    setNotes(existing?.notes ?? '')
  }, [editorId, existing])

  // Autosave notes so a workspace's scratchpad never needs an explicit save.
  useEffect(() => {
    if (!existing || notes === existing.notes) return
    const timer = setTimeout(() => {
      void window.browser.invoke('workspaces:update', { id: existing.id, notes })
    }, 500)
    return () => clearTimeout(timer)
  }, [notes, existing])

  if (editorId === null) return null

  const close = (): void => setWorkspaceEditor(null)

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    if (isNew) {
      await window.browser.invoke('workspaces:create', { name: trimmed, icon, color, isolated })
    } else if (existing) {
      await window.browser.invoke('workspaces:update', {
        id: existing.id,
        name: trimmed,
        icon,
        color
      })
    }
    close()
  }

  const isDefault = existing?.id === DEFAULT_WORKSPACE_ID

  return (
    <div className="space-y-5 p-4">
      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
            if (event.key === 'Escape') close()
          }}
          placeholder="Work, University, Research…"
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </Field>

      <Field label="Icon">
        <div className="flex flex-wrap gap-1">
          {WORKSPACE_ICONS.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setIcon(choice)}
              aria-label={ICON_LABELS[choice]}
              title={ICON_LABELS[choice]}
              aria-pressed={icon === choice}
              className={`flex size-8 cursor-default items-center justify-center rounded-lg transition ${
                icon === choice
                  ? 'bg-white/12 text-[var(--color-text-primary)] ring-1 ring-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:bg-white/6 hover:text-[var(--color-text-primary)]'
              }`}
            >
              <Icon name={choice} size={16} />
            </button>
          ))}
        </div>
      </Field>

      <Field label="Colour">
        <div className="flex gap-2">
          {WORKSPACE_COLORS.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setColor(choice)}
              aria-label={choice}
              aria-pressed={color === choice}
              className={`size-6 cursor-pointer rounded-full transition ${COLOR_CLASSES[choice].dot} ${
                color === choice ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-[var(--color-surface)]' : ''
              }`}
            />
          ))}
        </div>
      </Field>

      {isNew ? (
        <label className="flex cursor-pointer gap-3 rounded-lg border border-[var(--color-border-subtle)] p-3">
          <input
            type="checkbox"
            checked={isolated}
            onChange={(event) => setIsolated(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
          />
          <span>
            <span className="block text-sm">Isolated workspace</span>
            <span className="block text-xs text-[var(--color-text-muted)]">
              Separate cookies, storage and cache — you can be signed into the same site as a
              different account here. Tabs moved in or out reload signed out.{' '}
              <strong className="text-[var(--color-text-primary)]">
                This cannot be changed later.
              </strong>
            </span>
          </span>
        </label>
      ) : (
        existing && (
          <div className="rounded-lg border border-[var(--color-border-subtle)] p-3 text-xs text-[var(--color-text-muted)]">
            {existing.isolated ? (
              <>
                This workspace is <strong className="text-[var(--color-text-primary)]">isolated</strong> —
                its cookies and storage are separate.
              </>
            ) : (
              <>
                This workspace shares the default session. To get separate logins, duplicate it as an
                isolated workspace — isolation cannot be switched on in place without stranding the
                cookies already stored.
              </>
            )}
          </div>
        )
      )}

      {existing && (
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={6}
            placeholder="Scratchpad for this workspace. Saves as you type."
            className="w-full resize-y rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
        </Field>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!name.trim()}
          className="cursor-pointer rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black transition hover:opacity-90 disabled:cursor-default disabled:opacity-40"
        >
          {isNew ? 'Create' : 'Save'}
        </button>
        <button
          type="button"
          onClick={close}
          className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-sm transition hover:bg-white/5"
        >
          Cancel
        </button>
      </div>

      {existing && !isDefault && (
        <div className="space-y-2 border-t border-[var(--color-border-subtle)] pt-4">
          <button
            type="button"
            onClick={() => {
              void window.browser
                .invoke('workspaces:duplicate', { id: existing.id, isolated: false })
                .then(close)
            }}
            className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
          >
            <Icon name="plus" size={12} /> Duplicate workspace
          </button>
          <button
            type="button"
            onClick={() => {
              void window.browser
                .invoke('workspaces:duplicate', { id: existing.id, isolated: true })
                .then(close)
            }}
            className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
          >
            <Icon name="lock" size={12} /> Duplicate as isolated
          </button>
          {/*
            Archiving: keep the work, close the tabs.

            A research project ends and its tabs are still open, holding
            renderers and cluttering the strip, and closing them by hand loses
            where you got to. Its pages go into a restore point — the snapshot
            system that already exists, not a second store — so they come back
            whole, with scroll position and back-history.
          */}
          {existing.archivedAt === null ? (
            <button
              type="button"
              onClick={() => {
                void window.browser
                  .invoke('workspaces:archive', { id: existing.id })
                  .then((result) => {
                    if (!result.ok) return
                    // The refusals are sentences rather than a control that
                    // silently does nothing: you cannot archive the workspace
                    // you are standing in, or one with nothing in it.
                    if (result.value.refused) setNotice(result.value.refused)
                    else close()
                  })
              }}
              className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
            >
              <Icon name="folder" size={12} /> Archive workspace
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                void window.browser.invoke('workspaces:unarchive', { id: existing.id }).then(close)
              }}
              className="flex items-center gap-2 text-xs text-[var(--color-accent)] transition hover:opacity-80"
            >
              <Icon name="reload" size={12} /> Reopen this workspace
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void window.browser.invoke('workspaces:export', { id: existing.id }).then((result) => {
                if (!result.ok) return
                setNotice(
                  result.value.savedTo
                    ? `Exported ${result.value.tabs} ${
                        result.value.tabs === 1 ? 'address' : 'addresses'
                      }. No page content or signed-in state was included.`
                    : null
                )
              })
            }}
            className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
          >
            <Icon name="download" size={12} /> Export addresses and notes
          </button>
          <button
            type="button"
            onClick={() => {
              const ok = window.confirm(
                `Delete "${existing.name}"?\n\nIts open tabs will be closed. ` +
                  `${existing.isolated ? 'Its cookies and storage stay on disk until cleared.' : ''}`
              )
              if (ok) {
                void window.browser.invoke('workspaces:delete', { id: existing.id }).then(close)
              }
            }}
            className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-bad)]"
          >
            <Icon name="trash" size={12} /> Delete workspace
          </button>

          {existing.archivedAt !== null && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Archived. Its pages are kept in a restore point and its notes are untouched.
            </p>
          )}
          {notice && <p className="text-xs text-[var(--color-text-muted)]">{notice}</p>}
        </div>
      )}

      {isDefault && (
        <p className="border-t border-[var(--color-border-subtle)] pt-4 text-xs text-[var(--color-text-muted)]">
          The default workspace cannot be deleted — a tab always needs somewhere to live.
        </p>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
        {label}
      </span>
      {children}
    </div>
  )
}
