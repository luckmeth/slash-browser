import { useEffect, useMemo, useState } from 'react'
import { buildProtectionReport, REPORT_WINDOW_DAYS, type ProtectionDay } from '@shared/protectionReport'
import { Icon } from '../../components/Icon'

/**
 * What Slash actually did this week.
 *
 * Every line names where its figure came from, in a sentence under the number.
 * That is not decoration — it is the difference between this and the genre of
 * dashboard it resembles, which fills a page with confident totals nobody can
 * trace. A figure with no source does not appear here at all.
 *
 * Two things it deliberately does not say. There is no "you saved 4 hours":
 * nothing in this browser measures anybody's time, and a number like that would
 * make every other figure on the page untrustworthy. And there is no list of
 * sites — the table behind this holds counts by day and nothing else, because a
 * record of which sites blocked what would be a second history of everywhere
 * somebody has been.
 *
 * Entirely local and entirely offline. Nothing is fetched to draw it.
 */
export function ProtectionPanel(): React.JSX.Element {
  const [days, setDays] = useState<ProtectionDay[]>([])
  const [permissionsDenied, setPermissionsDenied] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const load = (): void => {
    void window.browser.invoke('protection:week', undefined).then((result) => {
      if (result.ok) {
        setDays(result.value.days)
        setPermissionsDenied(result.value.permissionsDenied)
      }
      setLoaded(true)
    })
  }

  useEffect(load, [])

  const report = useMemo(
    () => buildProtectionReport({ days, permissionsDenied }),
    [days, permissionsDenied]
  )

  if (!loaded) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">Reading…</p>
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-semibold">What Slash did this week</h3>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          The last {REPORT_WINDOW_DAYS} days, counted on this device. Nothing here was sent
          anywhere, and nothing here records which sites you visited.
        </p>
      </div>

      {report.empty ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-3 text-xs text-[var(--color-text-muted)]">
          Nothing to report yet. Counts start when something happens — a request blocked, a tab
          hibernated, a permission refused — so a quiet week looks like this rather than like a
          page of zeroes.
        </p>
      ) : (
        <ul className="space-y-2">
          {report.lines.map((line) => (
            <li
              key={line.id}
              className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3"
            >
              <p className="flex items-baseline gap-2">
                <strong className="text-lg tabular-nums">{line.value}</strong>
                <span className="text-sm">{line.label}</span>
                {/*
                  Every figure carries its confidence. Nothing here is currently
                  estimated — the label exists so that if a projected number is
                  ever added it has to be marked rather than blending in.
                */}
                <span className="ml-auto shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] tracking-wide text-[var(--color-text-muted)] uppercase">
                  {line.confidence}
                </span>
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{line.source}</p>
            </li>
          ))}
        </ul>
      )}

      {report.daysCovered > 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Counted across {report.daysCovered}{' '}
          {report.daysCovered === 1 ? 'day' : 'days'} with activity.
        </p>
      )}

      <div className="rounded-lg border border-[var(--color-border-subtle)] p-3">
        <p className="flex items-start gap-2 text-xs text-[var(--color-text-muted)]">
          <Icon name="lock" size={13} className="mt-0.5 shrink-0" />
          <span>
            These are counts by day and nothing else — no addresses, no hosts, no tab titles. They
            are kept for a month and then dropped, and they never leave this machine.
          </span>
        </p>
        {confirmingClear ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs">Forget the counts? This cannot be undone.</span>
            <button
              type="button"
              onClick={() => {
                void window.browser.invoke('protection:clear', undefined).then(() => {
                  setConfirmingClear(false)
                  load()
                })
              }}
              className="cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-1 text-xs transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
            >
              Forget them
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClear(false)}
              className="cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-1 text-xs transition hover:border-[var(--color-accent)]"
            >
              Keep them
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            className="mt-2 cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-1 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Clear this history
          </button>
        )}
      </div>
    </div>
  )
}
