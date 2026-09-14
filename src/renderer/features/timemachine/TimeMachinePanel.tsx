import { useEffect, useState } from 'react'
import type { Snapshot, SnapshotDetail } from '@shared/types/snapshot'
import { hostOf } from '@shared/url'
import { Icon } from '../../components/Icon'

/**
 * Restore points, grouped by day.
 *
 * The standing caveat at the top is not decoration: a snapshot restores pages
 * and navigation history, not logged-in state. A session that expired while the
 * browser was closed lands on a sign-in page, and promising otherwise would be
 * claiming a capability the engine does not have.
 */
export function TimeMachinePanel(): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [detail, setDetail] = useState<SnapshotDetail | null>(null)
  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('')
  /**
   * The last thing that happened, and how to take it back.
   *
   * Restoring is additive — nothing is destroyed — so undoing it is exactly
   * "close the tabs that arrived". A button promising more than that would be
   * describing a restore that never happened.
   */
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null)
  /** Which snapshot is being renamed, and to what. */
  const [renaming, setRenaming] = useState<number | null>(null)
  const [newLabel, setNewLabel] = useState('')

  const refresh = (): void => {
    void window.browser.invoke('snapshots:list', undefined).then((result) => {
      if (result.ok) setSnapshots(result.value)
    })
  }

  useEffect(refresh, [])

  useEffect(() => {
    if (expanded === null) {
      setDetail(null)
      return
    }
    void window.browser.invoke('snapshots:detail', { id: expanded }).then((result) => {
      if (result.ok) setDetail(result.value)
    })
  }, [expanded])

  const createPoint = (): void => {
    const trimmed = label.trim()
    if (!trimmed) return
    void window.browser.invoke('snapshots:create', { label: trimmed }).then((result) => {
      if (result.ok) setSnapshots(result.value)
      setLabel('')
      setNaming(false)
    })
  }

  /**
   * Names a restore point, which also keeps it.
   *
   * The repository promotes a renamed snapshot to `manual`, because otherwise
   * `pruneAutomatic` would delete the thing somebody had just said they wanted
   * — the copy says so rather than leaving that as a surprise a fortnight later.
   */
  const renamePoint = (id: number): void => {
    const trimmed = newLabel.trim()
    if (trimmed === '') return
    void window.browser.invoke('snapshots:rename', { id, label: trimmed }).then((result) => {
      if (result.ok) setSnapshots(result.value)
      setRenaming(null)
      setNotice({ text: 'Renamed. Named restore points are kept until you delete them.' })
    })
  }

  const groups = groupByDay(snapshots)

  return (
    <div className="space-y-4 p-4">
      <div>
        {naming ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createPoint()
                if (event.key === 'Escape') setNaming(false)
              }}
              placeholder="Name this restore point"
              className="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="button"
              onClick={createPoint}
              className="cursor-default rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black"
            >
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="flex w-full cursor-default items-center justify-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Icon name="plus" size={14} />
            Save a restore point
          </button>
        )}
      </div>

      <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-3 text-xs text-[var(--color-text-muted)]">
        Restore points bring back <strong>pages</strong> — which tabs were open, their order,
        pinning, scroll position and back/forward history. They cannot bring back being signed in:
        if a login expired while the browser was closed, that tab will open at a sign-in page.
      </p>

      {notice && (
        <p role="status" className="flex items-center gap-2 text-xs text-[var(--color-good)]">
          {notice.text}
          {notice.undo && (
            <button
              type="button"
              onClick={notice.undo}
              className="cursor-default underline decoration-dotted underline-offset-2 hover:text-[var(--color-text-primary)]"
            >
              Undo
            </button>
          )}
        </p>
      )}

      {snapshots.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Nothing recorded yet. A restore point is saved automatically every few minutes and
          whenever you close the browser.
        </p>
      ) : (
        groups.map(([day, entries]) => (
          <section key={day}>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
              {day}
            </h3>
            <ul className="space-y-1">
              {entries.map((snapshot) => (
                <li
                  key={snapshot.id}
                  className="rounded-lg border border-[var(--color-border-subtle)]"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === snapshot.id ? null : snapshot.id)}
                    className="flex w-full cursor-default items-center gap-2 px-3 py-2 text-left"
                  >
                    <Icon
                      name={snapshot.kind === 'manual' ? 'star' : 'clock'}
                      size={13}
                      className={
                        snapshot.kind === 'manual'
                          ? 'shrink-0 text-[var(--color-accent)]'
                          : 'shrink-0 text-[var(--color-text-muted)]'
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{snapshot.label}</span>
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {snapshot.tabCount} {snapshot.tabCount === 1 ? 'tab' : 'tabs'}
                        {snapshot.workspaceCount > 1 &&
                          ` across ${snapshot.workspaceCount} workspaces`}
                        {snapshot.kind === 'session-end' && ' · when you last closed the browser'}
                      </span>
                    </span>
                  </button>

                  {renaming === snapshot.id && (
                    <div className="flex gap-2 border-t border-[var(--color-border-subtle)] px-3 py-2">
                      <input
                        autoFocus
                        value={newLabel}
                        onChange={(event) => setNewLabel(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') renamePoint(snapshot.id)
                          if (event.key === 'Escape') setRenaming(null)
                        }}
                        aria-label="Rename this restore point"
                        className="min-w-0 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                      />
                      <Action label="Save" onClick={() => renamePoint(snapshot.id)} />
                      <Action label="Cancel" onClick={() => setRenaming(null)} />
                    </div>
                  )}

                  {expanded === snapshot.id && detail && (
                    <div className="border-t border-[var(--color-border-subtle)] px-3 py-2">
                      <ul className="mb-2 max-h-52 space-y-0.5 overflow-y-auto">
                        {detail.tabs.map((tab, index) => (
                          <li key={index} className="flex items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate" title={tab.url}>
                              {tab.title || hostOf(tab.url)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                void window.browser
                                  .invoke('snapshots:restoreTab', {
                                    id: snapshot.id,
                                    tabIndex: index
                                  })
                                  .then((result) => {
                                    if (!result.ok) return
                                    const { tabIds } = result.value
                                    setNotice({
                                      text: 'Tab reopened in this workspace.',
                                      undo:
                                        tabIds.length > 0
                                          ? () => {
                                              for (const tabId of tabIds) {
                                                void window.browser.invoke('tabs:close', { tabId })
                                              }
                                              setNotice(null)
                                            }
                                          : undefined
                                    })
                                  })
                              }}
                              className="shrink-0 cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                            >
                              Reopen
                            </button>
                          </li>
                        ))}
                      </ul>

                      <div className="flex flex-wrap gap-1.5">
                        <Action
                          label="Restore all"
                          onClick={() => {
                            void window.browser
                              .invoke('snapshots:restore', {
                                id: snapshot.id,
                                intoNewWorkspace: false
                              })
                              .then((result) => {
                                if (!result.ok) return
                                setNotice(restoreNotice(result.value, setNotice))
                              })
                          }}
                        />
                        <Action
                          label="Restore into a new workspace"
                          onClick={() => {
                            void window.browser
                              .invoke('snapshots:restore', {
                                id: snapshot.id,
                                intoNewWorkspace: true
                              })
                              .then((result) => {
                                if (!result.ok) return
                                setNotice(restoreNotice(result.value, setNotice, true))
                              })
                          }}
                        />
                        <Action
                          label="Rename"
                          onClick={() => {
                            setRenaming(snapshot.id)
                            setNewLabel(snapshot.label)
                          }}
                        />
                        <Action
                          label="Delete"
                          danger
                          onClick={() => {
                            void window.browser
                              .invoke('snapshots:delete', { id: snapshot.id })
                              .then((result) => {
                                if (result.ok) setSnapshots(result.value)
                                setExpanded(null)
                              })
                          }}
                        />
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

/**
 * What to say after a restore, and how to take it back.
 *
 * One builder for both restore buttons, because the undo is the part that has
 * to be right and two copies of it is two chances to close the wrong tabs.
 * Only this window's tabs come back in `tabIds`, so a restore that opened
 * extra windows says so rather than offering an undo that half works.
 */
function restoreNotice(
  value: { restored: number; windows: number; tabIds: string[] },
  setNotice: (notice: Notice | null) => void,
  intoNewWorkspace = false
): Notice {
  const { restored, windows, tabIds } = value
  return {
    text:
      `Reopened ${restored} ${restored === 1 ? 'tab' : 'tabs'}` +
      (intoNewWorkspace ? ' in a new workspace' : '') +
      (windows > 1 ? ` across ${windows} windows.` : '.'),
    undo:
      tabIds.length > 0 && windows === 1
        ? () => {
            for (const tabId of tabIds) {
              void window.browser.invoke('tabs:close', { tabId })
            }
            setNotice(null)
          }
        : undefined
  }
}

interface Notice {
  text: string
  undo?: () => void
}

function Action({
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
      className={`cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-1 text-xs transition ${
        danger
          ? 'hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]'
          : 'hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
      }`}
    >
      {label}
    </button>
  )
}

/** Today / Yesterday / a date, so the list reads as a timeline rather than rows. */
function groupByDay(snapshots: readonly Snapshot[]): Array<[string, Snapshot[]]> {
  const groups = new Map<string, Snapshot[]>()
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()

  for (const snapshot of snapshots) {
    const day = new Date(snapshot.createdAt).toDateString()
    const key = day === today ? 'Today' : day === yesterday ? 'Yesterday' : day
    const bucket = groups.get(key)
    if (bucket) bucket.push(snapshot)
    else groups.set(key, [snapshot])
  }
  return [...groups.entries()]
}
