import { useEffect, useState } from 'react'
import type { ImportSource, ImportSummary } from '@shared/types/importer'

/**
 * Import from another browser.
 *
 * Two things this is careful about:
 *
 *  - It says what is **not** carried across before you press the button.
 *    Someone who imports expecting their saved passwords and only discovers the
 *    gap at their next login has been misled by omission.
 *  - It reports what happened in real numbers, including what was skipped as
 *    already present, so a second import that adds nothing looks like the
 *    no-op it is rather than a failure.
 */
export function ImportSection(): React.JSX.Element {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  useEffect(() => {
    void window.browser.invoke('import:sources', undefined).then((result) => {
      if (!result.ok) {
        setSources([])
        return
      }
      setSources(result.value)
      setSelected(result.value[0]?.id ?? '')
    })
  }, [])

  const run = (): void => {
    if (selected === '' || running) return
    setRunning(true)
    setSummary(null)
    void window.browser
      .invoke('import:run', { sourceId: selected, bookmarks: true, history: true })
      .then((result) => {
        setRunning(false)
        if (result.ok) setSummary(result.value)
      })
  }

  if (sources === null) {
    return <p className="text-xs text-[var(--color-text-muted)]">Looking for other browsers…</p>
  }

  if (sources.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)]">
        No other Chromium browser was found on this machine. Slash can read Chrome, Edge, Brave,
        Vivaldi and Opera profiles.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <select
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        aria-label="Browser profile to import from"
        className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
      >
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.browser} — {source.profile}
          </option>
        ))}
      </select>

      <button
        type="button"
        disabled={running}
        onClick={run}
        className="w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
      >
        {running ? 'Importing…' : 'Import bookmarks and history'}
      </button>

      <p className="text-[11px] text-[var(--color-text-muted)]">
        Bookmarks arrive in their own dated folder, so nothing is mixed into yours and the whole
        import can be undone by deleting one folder. Pages you already have are merged, not
        duplicated.
      </p>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        <span className="text-[var(--color-text-primary)]">Not carried across:</span> saved
        passwords, cookies, payment details, extensions or open tabs. You will stay signed out of
        sites here even though you are signed in there.
      </p>

      {summary && (
        <div className="rounded-lg border border-[var(--color-border-subtle)] p-2.5 text-[11px]">
          <p className="text-[var(--color-text-primary)]">
            {summary.bookmarksAdded.toLocaleString()} bookmark
            {summary.bookmarksAdded === 1 ? '' : 's'} and {summary.historyAdded.toLocaleString()}{' '}
            page{summary.historyAdded === 1 ? '' : 's'} added.
          </p>
          {(summary.bookmarksSkipped > 0 || summary.historyMerged > 0) && (
            <p className="mt-0.5 text-[var(--color-text-muted)]">
              {summary.bookmarksSkipped.toLocaleString()} bookmark
              {summary.bookmarksSkipped === 1 ? '' : 's'} and{' '}
              {summary.historyMerged.toLocaleString()} page
              {summary.historyMerged === 1 ? '' : 's'} were already here.
            </p>
          )}
          {summary.warning && (
            <p className="mt-1 text-[var(--color-bad)]">{summary.warning}</p>
          )}
        </div>
      )}
    </div>
  )
}
