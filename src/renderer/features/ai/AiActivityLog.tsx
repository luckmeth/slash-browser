import { useCallback, useEffect, useState } from 'react'
import type { AiActivity } from '@shared/types/ai'

/**
 * Everything the assistant has proposed, done, or been stopped from doing.
 *
 * ## Why this exists
 *
 * Principle 5 is *AI never acts without approval*, and the pipeline that
 * enforces it — UNDERSTAND → PLAN → PREVIEW → APPROVE → EXECUTE → REPORT —
 * writes a row at every step. Every one of those rows was being recorded and
 * **nothing displayed them**. An audit trail nobody can read is not an audit
 * trail; it is a table.
 *
 * ## What it is careful about
 *
 * **A proposal is not an action.** `proposed` and `cancelled` mean the
 * assistant suggested something and it did not happen, and the list has to make
 * that unmistakable — otherwise reading your own history would suggest the
 * browser did far more on your behalf than it did.
 *
 * **Rows are not symmetrical, and pretending otherwise would misreport them.**
 * `proposed` and `failed` carry the request you typed; `executed`, `cancelled`
 * and `undone` carry only what the assistant understood, because by then the
 * plan is what identifies the work. So each row shows whichever it has and says
 * which one it is showing.
 */

/** Outcomes the engine actually writes. `approved` is in the schema but unused. */
type Outcome = 'proposed' | 'executed' | 'cancelled' | 'undone' | 'failed' | string

interface OutcomeStyle {
  readonly label: string
  readonly tone: string
  /** Whether anything actually changed. Drives the "nothing happened" wording. */
  readonly acted: boolean
}

function styleFor(outcome: Outcome): OutcomeStyle {
  switch (outcome) {
    case 'executed':
      return {
        label: 'done',
        tone: 'border-[var(--color-good)] text-[var(--color-good)]',
        acted: true
      }
    case 'undone':
      return {
        label: 'undone',
        tone: 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]',
        acted: true
      }
    case 'failed':
      return {
        label: 'failed',
        tone: 'border-[var(--color-bad)] text-[var(--color-bad)]',
        acted: false
      }
    case 'cancelled':
      return {
        label: 'cancelled',
        tone: 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]',
        acted: false
      }
    case 'proposed':
      return {
        label: 'proposed only',
        tone: 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]',
        acted: false
      }
    default:
      return {
        label: outcome,
        tone: 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]',
        acted: false
      }
  }
}

/** "3 minutes ago", and an absolute time in the tooltip for anything older. */
function whenText(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function AiActivityLog({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [entries, setEntries] = useState<AiActivity[] | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback((): void => {
    void window.browser.invoke('ai:activity', { limit: 50 }).then((result) => {
      if (result.ok) setEntries(result.value)
      else setEntries([])
    })
  }, [])

  // Reloaded whenever the panel applies, cancels or undoes something, so the
  // record of what just happened is there when the user looks for it.
  useEffect(() => {
    if (open) load()
  }, [open, refreshKey, load])

  const now = Date.now()

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-default items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs font-medium tracking-wide uppercase">Activity</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {open ? 'Hide' : 'Show what the assistant has done'}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--color-border-subtle)] p-3">
          {entries === null && (
            <p className="text-xs text-[var(--color-text-muted)]">Reading the record…</p>
          )}

          {entries?.length === 0 && (
            <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
              Nothing yet. Every request, every plan and every action the assistant takes is
              recorded here — including the ones you cancel.
            </p>
          )}

          {entries && entries.length > 0 && (
            <>
              <ul className="space-y-2">
                {entries.map((entry) => {
                  const style = styleFor(entry.outcome)
                  // `executed` and `undone` rows carry no request text; the
                  // understanding is what identifies them by then.
                  const heading = entry.request.trim() || entry.understanding.trim()
                  const fromRequest = entry.request.trim() !== ''

                  return (
                    <li
                      key={entry.id}
                      className="rounded-md border border-[var(--color-border-subtle)] p-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 flex-1 text-xs">
                          {heading === '' ? (
                            <span className="text-[var(--color-text-muted)] italic">
                              (no description recorded)
                            </span>
                          ) : (
                            heading
                          )}
                        </p>
                        <span
                          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${style.tone}`}
                        >
                          {style.label}
                        </span>
                      </div>

                      <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                        <span title={new Date(entry.at).toLocaleString()}>
                          {whenText(entry.at, now)}
                        </span>
                        {' · '}
                        {fromRequest ? 'what you asked' : 'what it understood'}
                        {entry.actionCount > 0 && (
                          <>
                            {' · '}
                            {entry.actionCount} action{entry.actionCount === 1 ? '' : 's'}
                            {/*
                              The distinction the whole log turns on: a plan with
                              four actions that was cancelled changed nothing,
                              and a list that showed "4 actions" without saying
                              so would read as four things having happened.
                            */}
                            {!style.acted && ' — none carried out'}
                          </>
                        )}
                      </p>

                      {entry.detail.trim() !== '' && (
                        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                          {entry.detail}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>

              <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                The 50 most recent entries, kept on this machine and never sent anywhere.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
