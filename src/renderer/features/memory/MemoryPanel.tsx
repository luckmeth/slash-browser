import { useEffect, useState } from 'react'
import type { MemoryResult, MemoryStats, ParsedQuery } from '@shared/types/memory'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { SemanticStatusCard } from './SemanticStatusCard'
import { useSemanticStatus } from './useSemanticStatus'

/**
 * Web Memory search.
 *
 * Two things this panel is careful about:
 *  - it shows **why** each result matched. A memory search that cannot explain
 *    itself is indistinguishable from a guess.
 *  - it echoes back the time window it understood, so "last Tuesday" filtering
 *    results is visible rather than mysterious.
 */
export function MemoryPanel(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryResult[]>([])
  const [parsed, setParsed] = useState<ParsedQuery | null>(null)
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [searching, setSearching] = useState(false)
  const settings = useBrowserStore((s) => s.settings)
  const { status: semantic, setEnabled: setSemanticEnabled } = useSemanticStatus()

  const loadStats = (): void => {
    void window.browser.invoke('memory:stats', undefined).then((result) => {
      if (result.ok) setStats(result.value)
    })
  }

  useEffect(loadStats, [])

  useEffect(() => {
    if (query.trim() === '') {
      setResults([])
      setParsed(null)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void window.browser.invoke('memory:search', { query, limit: 30 }).then((result) => {
        setSearching(false)
        if (result.ok) {
          setResults(result.value.results)
          setParsed(result.value.parsed)
        }
      })
    }, 180)
    return () => clearTimeout(timer)
  }, [query])

  const indexingOff = settings && !settings.indexHistory

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] p-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try: react auth article last tuesday"
          aria-label="Search your browsing memory"
          className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        {parsed?.timeLabel && (
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
            Searching{' '}
            <span className="text-[var(--color-accent)]">
              {parsed.terms || 'everything'}
            </span>{' '}
            from <span className="text-[var(--color-accent)]">{parsed.timeLabel}</span>
          </p>
        )}
        {/*
          Said while it is true, not only on the empty screen. Results during a
          backfill are correct but incomplete, and a user who does not know that
          reads a thin result list as "it did not find it".
        */}
        {semantic?.state === 'indexing' && query.trim() !== '' && (
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
            Still reading {semantic.pendingPages.toLocaleString()} older page
            {semantic.pendingPages === 1 ? '' : 's'} — matches by meaning will improve.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {indexingOff ? (
          // The honest empty state: nothing is indexed because nothing was
          // allowed to be, not because search is broken.
          <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-4">
            <p className="text-sm font-medium">Browsing memory is off</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Nothing has been indexed. Turn it on in Settings → Privacy to make the pages you visit
              searchable. Everything stays on this machine.
            </p>
          </div>
        ) : query.trim() === '' ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-text-muted)]">
              Search the pages you have visited — by what was on them, not just their titles.
            </p>
            {stats && (
              <dl className="space-y-1 text-xs text-[var(--color-text-muted)]">
                <Row label="Pages indexed" value={String(stats.pageCount)} />
                <Row label="With full text" value={String(stats.withContent)} />
                {stats.oldestIndexedAt && (
                  <Row
                    label="Oldest entry"
                    value={new Date(stats.oldestIndexedAt).toLocaleDateString()}
                  />
                )}
              </dl>
            )}
            <p className="text-xs text-[var(--color-text-muted)]">
              Examples: <em>postgres scaling last month</em> · <em>invoice 3 days ago</em> ·{' '}
              <em>that article about react auth</em>
            </p>
            <SemanticStatusCard status={semantic} onSetEnabled={setSemanticEnabled} />
          </div>
        ) : searching ? (
          <p className="text-sm text-[var(--color-text-muted)]">Searching…</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Nothing matched. {parsed?.timeLabel && `Try removing “${parsed.timeLabel}”, or `}
            check that content indexing is on in Settings.
          </p>
        ) : (
          <ul className="space-y-2">
            {results.map((result) => (
              <li
                key={result.pageId}
                className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <button
                  type="button"
                  onClick={() =>
                    void window.browser.invoke('tabs:create', {
                      url: result.url,
                      background: false
                    })
                  }
                  className="w-full cursor-default text-left"
                >
                  <p className="truncate text-sm">{result.title || hostOf(result.url)}</p>
                  <p className="truncate text-xs text-[var(--color-text-muted)]">
                    {result.siteName ?? hostOf(result.url)} ·{' '}
                    {new Date(result.visitedAt).toLocaleDateString()}
                  </p>
                  {result.snippet && (
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                      {result.snippet}
                    </p>
                  )}
                </button>

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {result.reasons.map((reason, index) => (
                    <span
                      key={index}
                      // A meaning match is marked out because it is a different
                      // kind of claim from a word match: the browser is saying
                      // these are *about* the same thing, which the user should
                      // be able to weigh differently from "this word is on the
                      // page".
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${
                        reason.kind === 'semantic'
                          ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                          : 'border-[var(--color-border-subtle)] text-[var(--color-text-muted)]'
                      }`}
                    >
                      {reason.detail}
                    </span>
                  ))}
                  <button
                    type="button"
                    title="Remove this page from your browsing memory"
                    onClick={() => {
                      void window.browser
                        .invoke('memory:forget', { url: result.url })
                        .then((response) => {
                          if (response.ok) setStats(response.value)
                          setResults((current) =>
                            current.filter((item) => item.pageId !== result.pageId)
                          )
                        })
                    }}
                    className="ml-auto cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
                  >
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {stats && stats.pageCount > 0 && (
        <div className="border-t border-[var(--color-border-subtle)] p-3">
          <button
            type="button"
            onClick={() => {
              void window.browser.invoke('memory:clear', undefined).then((result) => {
                if (result.ok) setStats(result.value)
                setResults([])
              })
            }}
            className="flex w-full cursor-default items-center justify-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
          >
            <Icon name="close" size={12} />
            Delete everything indexed
          </button>
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-[var(--color-text-primary)]">{value}</dd>
    </div>
  )
}
