import { useEffect, useState } from 'react'
import type { WatchStatus } from '@shared/types/watch'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * Watched pages and what changed on them.
 *
 * Says how the checking works, because the alternative assumption is worse: a
 * user who thinks Slash is polling their watched pages every hour would
 * reasonably expect to be told about a change the moment it happens. It checks
 * when you next visit the page, and nothing is fetched in the background.
 */
export function WatchPanel(): React.JSX.Element {
  const [status, setStatus] = useState<WatchStatus | null>(null)
  const activeTab = useBrowserStore((s) => s.activeTab())

  const refresh = (): void => {
    void window.browser.invoke('watch:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(() => {
    refresh()
    return window.browser.on('watch:changed', refresh)
  }, [activeTab?.url])

  // Opening the panel is the act of looking at the changes, so they stop being
  // unseen. A badge that needs a separate dismissal is a second chore.
  useEffect(() => {
    if (status && status.unseenCount > 0) {
      void window.browser.invoke('watch:markSeen', undefined).then((result) => {
        if (result.ok) setStatus(result.value)
      })
    }
  }, [status?.unseenCount])

  if (!status) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading…</p>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] p-3">
        <button
          type="button"
          disabled={!activeTab || !/^https?:\/\//i.test(activeTab.url)}
          onClick={() =>
            void window.browser.invoke('watch:toggle', undefined).then((result) => {
              if (result.ok) setStatus(result.value)
            })
          }
          className="w-full cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
        >
          {status.watching ? 'Stop watching this page' : 'Watch this page'}
        </button>
        <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
          Checked when you next visit the page — Slash never fetches it in the background. Only the
          previous version's text is kept, not a copy of every version.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {status.pages.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No pages watched yet. Useful for a job posting, a price, a set of deadlines or a terms
            page.
          </p>
        ) : (
          <ul className="space-y-2">
            {status.pages.map((page) => (
              <li
                key={page.id}
                className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void window.browser.invoke('tabs:create', {
                        url: page.url,
                        background: false
                      })
                    }
                    className="min-w-0 cursor-default text-left"
                  >
                    <p className="truncate text-sm">{page.title || hostOf(page.url)}</p>
                    <p className="truncate text-[11px] text-[var(--color-text-muted)]">
                      {hostOf(page.url)}
                      {page.lastCheckedAt
                        ? ` · checked ${new Date(page.lastCheckedAt).toLocaleDateString()}`
                        : ' · not yet compared'}
                    </p>
                  </button>
                  <button
                    type="button"
                    title="Stop watching and delete what was stored"
                    onClick={() =>
                      void window.browser
                        .invoke('watch:remove', { url: page.url })
                        .then((result) => {
                          if (result.ok) setStatus(result.value)
                        })
                    }
                    className="shrink-0 cursor-default rounded border border-[var(--color-border-subtle)] p-1 text-[var(--color-text-muted)] transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>

                {page.changes.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                    No changes since you started watching.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {page.changes.slice(0, 4).map((change) => (
                      <li
                        key={change.id}
                        className="border-l-2 border-[var(--color-accent)] pl-2"
                      >
                        <p className="text-[11px] text-[var(--color-text-primary)]">
                          {change.summary}
                        </p>
                        <p className="text-[10px] text-[var(--color-text-muted)]">
                          {new Date(change.at).toLocaleString()}
                        </p>
                        {/* Removals shown before additions: information
                            disappearing — a salary, a deadline — is usually the
                            more significant event. */}
                        {change.removed && (
                          <p className="mt-0.5 line-clamp-2 text-[10px] text-[var(--color-bad)]">
                            − {change.removed}
                          </p>
                        )}
                        {change.added && (
                          <p className="mt-0.5 line-clamp-2 text-[10px] text-[var(--color-good)]">
                            + {change.added}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
