import { useEffect, useState } from 'react'
import type { CrashReport } from '@shared/types/diagnostics'

/**
 * Crash reporting, in Settings.
 *
 * States the thing that matters most about it: **nothing is uploaded.** Crash
 * dumps contain process memory, and therefore whatever was on the page when it
 * died, so shipping them automatically would contradict every other privacy claim
 * this browser makes. They sit in a folder the user can open and send
 * deliberately.
 */
export function DiagnosticsSection(): React.JSX.Element {
  const [report, setReport] = useState<CrashReport | null>(null)

  const refresh = (): void => {
    void window.browser.invoke('crashes:report', undefined).then((result) => {
      if (result.ok) setReport(result.value)
    })
  }

  useEffect(refresh, [])

  if (!report) {
    return <p className="text-xs text-[var(--color-text-muted)]">Checking…</p>
  }

  const nothing = report.events.length === 0 && report.dumpCount === 0

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-text-muted)]">
        {nothing
          ? 'No crashes recorded on this machine.'
          : `${report.events.length} crash${report.events.length === 1 ? '' : 'es'} recorded, ${report.dumpCount} dump${report.dumpCount === 1 ? '' : 's'} on disk.`}
      </p>

      {report.events.length > 0 && (
        <ul className="space-y-0.5">
          {report.events.slice(0, 6).map((event) => (
            <li key={event.id} className="text-[11px] text-[var(--color-text-muted)]">
              {new Date(event.at).toLocaleString()} · {event.process} · {event.reason}
              {event.code !== null ? ` (exit ${event.code})` : ''}
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-[var(--color-text-muted)]">
        <span className="text-[var(--color-text-primary)]">
          {report.uploadsEnabled ? 'Uploads are enabled.' : 'Nothing is uploaded.'}
        </span>{' '}
        Crashes are recorded on this machine only. Chromium is not retaining full memory dumps in
        this build, so what you have is the log above — process, reason and exit code.
      </p>

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void window.browser.invoke('crashes:openFolder', undefined)}
          className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Open the crash folder
        </button>
        {!nothing && (
          <button
            type="button"
            onClick={() =>
              void window.browser.invoke('crashes:clear', undefined).then((result) => {
                if (result.ok) setReport(result.value)
              })
            }
            className="cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
          >
            Delete crash data
          </button>
        )}
      </div>
    </div>
  )
}
