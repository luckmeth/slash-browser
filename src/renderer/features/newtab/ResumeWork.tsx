import { useEffect, useMemo, useState } from 'react'
import type { Snapshot } from '@shared/types/snapshot'
import type { Tab } from '@shared/types/tab'
import type { Workspace } from '@shared/types/workspace'
import { isInternalUrl } from '@shared/types/tab'
import { resumeCards, agoPhrase, RESUME_CAVEAT, type ResumeCard } from '@shared/resumeWork'
import { Icon, type IconName } from '../../components/Icon'

/**
 * Pick up where you left off.
 *
 * The whole risk in a feature like this is invention: a card reading
 * *Slash Browser Development · 18 tabs · yesterday* is easy to draw and easy to
 * make up. Every figure here comes from something the browser already recorded —
 * a restore point it wrote, or tabs open in a workspace right now — and
 * `resumeCards` is pure and tested so the ordering is a decision rather than
 * whatever the three fetches happened to return in.
 *
 * It renders nothing on a browser with no history, which is the common case for
 * a first launch. A section headed "Resume your work" above an empty space is
 * worse than no section.
 */
export function ResumeWork(): React.JSX.Element | null {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null)

  useEffect(() => {
    void window.browser.invoke('snapshots:list', undefined).then((result) => {
      if (result.ok) setSnapshots(result.value)
    })
    void window.browser.invoke('workspaces:list', undefined).then((result) => {
      if (result.ok) {
        setWorkspaces(result.value.workspaces)
        setActiveWorkspaceId(result.value.activeWorkspaceId)
      }
    })
    void window.browser.invoke('tabs:listAll', undefined).then((result) => {
      if (result.ok) setTabs(result.value.tabs)
    })
  }, [])

  /*
   * `now` is captured once per data change rather than read inside the pure
   * function, so the relative times do not shift between a render and its
   * assertions — and so a card cannot say "just now" on one paint and
   * "1 minute ago" on the next while nothing has happened.
   */
  const cards = useMemo(
    () =>
      resumeCards({
        snapshots,
        workspaces,
        activeWorkspaceId,
        tabs: tabs.map((tab) => ({
          workspaceId: tab.workspaceId,
          lastActiveAt: tab.lastActiveAt,
          isInternal: isInternalUrl(tab.url)
        })),
        now: Date.now()
      }),
    [snapshots, workspaces, activeWorkspaceId, tabs]
  )

  if (cards.length === 0) return null

  const resume = (card: ResumeCard): void => {
    if (card.kind === 'workspace') {
      void window.browser.invoke('workspaces:activate', { id: String(card.target) })
      return
    }

    setBusy(card.id)
    void window.browser
      .invoke('snapshots:restore', { id: Number(card.target), intoNewWorkspace: false })
      .then((result) => {
        setBusy(null)
        if (!result.ok) return
        const { restored, windows, tabIds } = result.value
        setNotice({
          text:
            `Reopened ${restored} ${restored === 1 ? 'tab' : 'tabs'}` +
            (windows > 1 ? ` across ${windows} windows.` : '.'),
          // Only offered when there is something to close. Restoring adds
          // rather than replaces, so undoing is exactly "close what arrived" —
          // and a button that promised more than that would be lying about
          // what restoring did in the first place.
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
  }

  return (
    <section className="animate-rise mt-10 w-full">
      <h2 className="mb-3 text-[11px] font-medium tracking-[0.12em] text-[var(--color-text-muted)] uppercase">
        Resume your work
      </h2>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            disabled={busy !== null}
            onClick={() => resume(card)}
            className="glass-raised group flex cursor-default items-center gap-3 rounded-xl p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--glass-edge-strong)] hover:bg-[var(--glass-high)] disabled:opacity-60"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/6">
              <Icon
                name={iconFor(card)}
                size={14}
                className="text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)]"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{card.title}</span>
              <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                {card.detail} · {agoPhrase(card.at, Date.now())}
              </span>
            </span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100">
              {card.kind === 'workspace' ? (card.current ? 'Current' : 'Switch') : 'Reopen'}
            </span>
          </button>
        ))}
      </div>

      {/*
        Under the cards rather than beside the heading, where it was truncated at
        any width worth using. The sentence is the honest limit of what a restore
        does, so it has to be readable — a caveat cut in half is worse than none.
        Only shown when something here actually restores pages: switching
        workspace does not touch signed-in state either way.
      */}
      {cards.some((card) => card.kind !== 'workspace') && (
        <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">{RESUME_CAVEAT}</p>
      )}

      {notice && (
        <p
          role="status"
          className="mt-2.5 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]"
        >
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
    </section>
  )
}

function iconFor(card: ResumeCard): IconName {
  if (card.kind === 'workspace') return 'wsFolder'
  if (card.kind === 'session') return 'reload'
  return 'clock'
}
