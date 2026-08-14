import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@shared/types/browsing'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * The new tab page.
 *
 * Rendered by the chrome document in the hole where a page view would sit, not
 * as a web page. That is why it can read history and bookmarks over the existing
 * IPC surface without a custom `app://` protocol and without granting any page
 * view privileges — and why it makes no network requests at all.
 */
export function NewTabPage(): React.JSX.Element {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const [topSites, setTopSites] = useState<HistoryEntry[]>([])

  useEffect(() => {
    void (async () => {
      const result = await window.browser.invoke('history:search', {
        query: '',
        limit: 60,
        offset: 0
      })
      if (!result.ok) return
      // Most-visited, one entry per host, so a single site cannot fill the grid.
      const seen = new Set<string>()
      const unique: HistoryEntry[] = []
      for (const entry of [...result.value].sort((a, b) => b.visitCount - a.visitCount)) {
        const host = hostOf(entry.url)
        if (seen.has(host)) continue
        seen.add(host)
        unique.push(entry)
        if (unique.length === 8) break
      }
      setTopSites(unique)
    })()
  }, [])

  const open = (url: string): void => {
    if (activeTabId) void window.browser.invoke('nav:navigate', { tabId: activeTabId, input: url })
  }

  const quickBookmarks = bookmarks.filter((b) => !b.isFolder).slice(0, 8)

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-surface)] px-8 py-14">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Adaptive Browser</h1>
        <p className="mb-10 text-sm text-[var(--color-text-muted)]">
          Press <Kbd>Ctrl</Kbd> <Kbd>L</Kbd> to search or type an address.
        </p>

        {topSites.length > 0 && (
          <Section title="Most visited">
            <div className="grid grid-cols-4 gap-3">
              {topSites.map((entry) => (
                <Tile
                  key={entry.id}
                  title={entry.title || hostOf(entry.url)}
                  subtitle={hostOf(entry.url)}
                  faviconUrl={entry.faviconUrl}
                  onClick={() => open(entry.url)}
                />
              ))}
            </div>
          </Section>
        )}

        {quickBookmarks.length > 0 && (
          <Section title="Bookmarks">
            <div className="grid grid-cols-4 gap-3">
              {quickBookmarks.map((bookmark) => (
                <Tile
                  key={bookmark.id}
                  title={bookmark.title}
                  subtitle={hostOf(bookmark.url)}
                  faviconUrl={bookmark.faviconUrl}
                  onClick={() => open(bookmark.url)}
                />
              ))}
            </div>
          </Section>
        )}

        {topSites.length === 0 && quickBookmarks.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--color-border-subtle)] p-8 text-center text-sm text-[var(--color-text-muted)]">
            Sites you visit and bookmark will appear here.
          </p>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-9">
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Tile({
  title,
  subtitle,
  faviconUrl,
  onClick
}: {
  title: string
  subtitle: string
  faviconUrl: string | null
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={subtitle}
      className="flex cursor-pointer flex-col items-start gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-left transition hover:border-[var(--color-accent)]"
    >
      {faviconUrl ? (
        <img
          src={faviconUrl}
          alt=""
          className="size-5 rounded"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden'
          }}
        />
      ) : (
        <Icon name="globe" size={20} className="text-[var(--color-text-muted)]" />
      )}
      <span className="w-full truncate text-sm font-medium">{title}</span>
      <span className="w-full truncate text-xs text-[var(--color-text-muted)]">{subtitle}</span>
    </button>
  )
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-xs">
      {children}
    </kbd>
  )
}
