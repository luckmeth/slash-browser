import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@shared/types/browsing'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

export function HistoryPanel(): React.JSX.Element {
  const history = useBrowserStore((s) => s.history)
  const refreshHistory = useBrowserStore((s) => s.refreshHistory)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const [query, setQuery] = useState('')

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
        <button
          type="button"
          onClick={() => {
            void window.browser.invoke('history:clear', {}).then(() => refreshHistory(query))
          }}
          className="mt-2 cursor-pointer text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-bad)]"
        >
          Clear all history
        </button>
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
