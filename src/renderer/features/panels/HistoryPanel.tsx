import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@shared/types/browsing'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * The ranges every other browser offers, and Slash did not.
 *
 * Ordered shortest first so the least destructive option is the default — the
 * opposite of a single "clear everything" button, which is the kind of control
 * people avoid touching at all.
 */
const RANGES = [
  { id: 'hour', label: 'Last hour', ms: 60 * 60 * 1000 },
  { id: 'day', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: 'week', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: 'month', label: 'Last 4 weeks', ms: 28 * 24 * 60 * 60 * 1000 },
  { id: 'year', label: 'Last year', ms: 365 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All time', ms: null }
] as const

type RangeId = (typeof RANGES)[number]['id']

/** Epoch ms to clear from, or null for everything. */
function sinceFor(id: RangeId): number | null {
  const range = RANGES.find((option) => option.id === id)
  if (!range || range.ms === null) return null
  return Date.now() - range.ms
}

export function HistoryPanel(): React.JSX.Element {
  const history = useBrowserStore((s) => s.history)
  const refreshHistory = useBrowserStore((s) => s.refreshHistory)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<RangeId>('hour')

  useEffect(() => {
    // Debounced so typing does not issue a query per keystroke.
    const timer = setTimeout(() => void refreshHistory(query), 180)
    return () => clearTimeout(timer)
  }, [query, refreshHistory])

  const groups = groupByDay(history)

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] p-3">
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--color-text-muted)]">
            <Icon name="search" size={13} />
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search history"
            aria-label="Search history"
            className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] py-1.5 pr-2 pl-8 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        {/*
          A range, not a single destructive button. "Clear all history" as the
          only option means someone who wanted to remove the last ten minutes
          has to destroy years of it — so most people simply do not clear
          anything. The repository has taken a cutoff all along; only the
          interface never offered one.
        */}
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs text-[var(--color-text-muted)]" htmlFor="history-range">
            Clear
          </label>
          <select
            id="history-range"
            value={range}
            onChange={(event) => setRange(event.target.value as RangeId)}
            className="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          >
            {RANGES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const since = sinceFor(range)
              void window.browser
                // `since` omitted entirely means everything, which is what the
                // contract documents; sending undefined would be the same but
                // reads as an accident.
                .invoke('history:clear', since === null ? {} : { since })
                .then(() => refreshHistory(query))
            }}
            className="cursor-pointer rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-xs transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
          >
            Clear
          </button>
        </div>
      </div>

      {history.length === 0 ? (
        <Empty message={query ? 'No matching history.' : 'No history yet.'} />
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {groups.map(([day, entries]) => (
            <li key={day}>
              <h3 className="px-2 pt-3 pb-1 text-xs font-semibold text-[var(--color-text-muted)]">
                {day}
              </h3>
              <ul>
                {entries.map((entry) => (
                  <li key={entry.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5">
                    <button
                      type="button"
                      onClick={() => {
                        if (activeTabId) {
                          void window.browser.invoke('nav:navigate', {
                            tabId: activeTabId,
                            input: entry.url
                          })
                        }
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                      title={entry.url}
                    >
                      <Favicon url={entry.faviconUrl} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {entry.title || hostOf(entry.url)}
                        </span>
                        <span className="block truncate text-xs text-[var(--color-text-muted)]">
                          {hostOf(entry.url)}
                          {entry.visitCount > 1 && ` · ${entry.visitCount} visits`}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${entry.title || entry.url}`}
                      onClick={() => {
                        void window.browser
                          .invoke('history:delete', { ids: [entry.id] })
                          .then(() => refreshHistory(query))
                      }}
                      className="shrink-0 cursor-pointer rounded p-1 opacity-0 transition group-hover:opacity-100 hover:bg-white/10"
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Groups into Today / Yesterday / date, preserving the recency ordering. */
function groupByDay(entries: HistoryEntry[]): [string, HistoryEntry[]][] {
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  const groups = new Map<string, HistoryEntry[]>()

  for (const entry of entries) {
    const day = new Date(entry.lastVisitedAt).toDateString()
    const label =
      day === today
        ? 'Today'
        : day === yesterday
          ? 'Yesterday'
          : new Date(entry.lastVisitedAt).toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric'
            })
    const bucket = groups.get(label)
    if (bucket) bucket.push(entry)
    else groups.set(label, [entry])
  }
  return [...groups.entries()]
}

export function Favicon({ url }: { url: string | null }): React.JSX.Element {
  if (!url) return <Icon name="globe" size={14} className="shrink-0 text-[var(--color-text-muted)]" />
  return (
    <img
      src={url}
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden'
      }}
    />
  )
}

export function Empty({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">{message}</p>
  )
}
