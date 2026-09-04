import { useEffect, useState } from 'react'
import { hostOf } from '@shared/url'
import { Icon } from '../../components/Icon'

interface ClosedEntry {
  url: string
  title: string
  faviconUrl: string | null
  closedAt: number
}

/**
 * Tabs closed recently, one click to bring back.
 *
 * Reads the *persisted* stack rather than the in-memory one, so it survives a
 * restart — which is when "I closed something I needed" most often bites, and
 * exactly when Ctrl+Shift+T has nothing left to offer.
 *
 * Renders nothing when there is nothing to show. An empty "Recently closed"
 * heading is worse than no heading: it takes up the same space and tells you
 * only that a feature exists somewhere else.
 */
export function RecentlyClosed(): React.JSX.Element | null {
  const [entries, setEntries] = useState<ClosedEntry[]>([])

  useEffect(() => {
    void window.browser.invoke('tabs:recentlyClosed', undefined).then((result) => {
      if (result.ok) setEntries(result.value.slice(0, 5))
    })
  }, [])

  if (entries.length === 0) return null

  return (
    <section className="animate-rise mt-10 w-full">
      <h2 className="mb-3 text-[11px] font-medium tracking-[0.12em] text-[var(--color-text-muted)] uppercase">
        Recently closed
      </h2>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <button
            key={`${entry.url}-${entry.closedAt}`}
            type="button"
            title={entry.url}
            onClick={() => {
              // Opens in a new tab rather than replacing this one: the closed
              // tab had its own back/forward history, and reusing the new tab
              // page's tab would silently merge the two.
              void window.browser.invoke('tabs:create', { url: entry.url, background: false })
            }}
            className="glass-raised group flex cursor-default items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-[var(--glass-high)]"
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              {entry.faviconUrl ? (
                <img
                  src={entry.faviconUrl}
                  alt=""
                  className="size-4 rounded-sm"
                  onError={(event) => {
                    event.currentTarget.style.visibility = 'hidden'
                  }}
                />
              ) : (
                <Icon name="globe" size={13} className="text-[var(--color-text-muted)]" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">
                {entry.title || hostOf(entry.url)}
              </span>
              <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                {hostOf(entry.url)} · {relativeTime(entry.closedAt)}
              </span>
            </span>
            <Icon
              name="plus"
              size={13}
              className="shrink-0 text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100"
            />
          </button>
        ))}
      </div>
    </section>
  )
}

/** Coarse on purpose — "3 hours ago" is what you want, not a timestamp. */
function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}
