import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@shared/types/browsing'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { BrandMark } from '../../components/BrandMark'
import { Icon } from '../../components/Icon'

/**
 * The start page.
 *
 * Rendered by the chrome document in the hole where a page view would be, which
 * is why it can read history and workspaces over the existing IPC surface
 * without registering a scheme or granting a page view any privileges.
 */
export function NewTabPage(): React.JSX.Element {
  const [topSites, setTopSites] = useState<HistoryEntry[]>([])
  const requestOmniboxFocus = useBrowserStore((s) => s.requestOmniboxFocus)
  const workspaces = useBrowserStore((s) => s.workspaces)
  const activeWorkspaceId = useBrowserStore((s) => s.activeWorkspaceId)
  const tabs = useBrowserStore((s) => s.tabs)

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)

  useEffect(() => {
    void window.browser
      .invoke('history:search', { query: '', limit: 60, offset: 0 })
      .then((result) => {
        if (!result.ok) return
        // Most-visited, then most-recent as the tie-break — a site opened once
        // yesterday should not outrank one used daily.
        const ranked = [...result.value]
          .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitedAt - a.lastVisitedAt)
          .slice(0, 8)
        setTopSites(ranked)
      })
  }, [])

  return (
    <div className="glass-page relative h-full overflow-y-auto">
      {/* Soft accent wash. Keeps a very large empty area from reading as dead
          space, without competing with anything. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(70rem 34rem at 50% -12%, rgba(110,168,254,0.16), transparent 62%),' +
            'radial-gradient(46rem 28rem at 88% 8%, rgba(150,110,254,0.10), transparent 60%)'
        }}
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center px-8 pt-[14vh] pb-16">
        <div className="animate-rise flex flex-col items-center">
          <BrandMark size={54} className="text-[var(--color-text-primary)]" />
          <h1 className="mt-4 text-[28px] leading-none font-semibold tracking-tight">
            Slash
          </h1>
          {workspace && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <Icon name={workspace.icon} size={12} />
              {workspace.name}
              {workspace.isolated && (
                <span className="flex items-center gap-1">
                  <Icon name="lock" size={10} />
                  isolated
                </span>
              )}
              <span aria-hidden="true">·</span>
              {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
            </p>
          )}
        </div>

        {/* Focuses the real omnibox rather than being a second input that would
            then have to duplicate suggestions, history and URL resolution. */}
        <button
          type="button"
          onClick={requestOmniboxFocus}
          className="glass-raised animate-rise mt-8 flex w-full max-w-xl cursor-text items-center gap-3 rounded-2xl px-4 py-3 text-left transition hover:border-[var(--glass-edge-strong)]"
        >
          <Icon name="search" size={16} className="shrink-0 text-[var(--color-text-muted)]" />
          <span className="text-sm text-[var(--color-text-muted)]">Search or enter address</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Key>Ctrl</Key>
            <Key>L</Key>
          </span>
        </button>

        {topSites.length > 0 && (
          <section className="animate-rise mt-10 w-full">
            <h2 className="mb-3 text-[11px] font-medium tracking-[0.12em] text-[var(--color-text-muted)] uppercase">
              Frequently visited
            </h2>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {topSites.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  title={site.url}
                  onClick={() =>
                    void window.browser.invoke('nav:navigate', {
                      tabId: tabs.find((t) => isInternalUrl(t.url))?.id ?? '',
                      input: site.url
                    })
                  }
                  className="glass-raised group flex cursor-default flex-col gap-2.5 rounded-xl p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--glass-edge-strong)] hover:bg-[var(--glass-high)]"
                >
                  <span className="flex size-8 items-center justify-center rounded-lg bg-white/6">
                    {site.faviconUrl ? (
                      <img
                        src={site.faviconUrl}
                        alt=""
                        className="size-4 rounded-sm"
                        onError={(event) => {
                          event.currentTarget.style.visibility = 'hidden'
                        }}
                      />
                    ) : (
                      <Icon name="globe" size={14} className="text-[var(--color-text-muted)]" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">
                      {site.title || hostOf(site.url)}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                      {hostOf(site.url)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="flex-1" />

        <p className="mt-10 text-[11px] text-[var(--color-text-muted)]">
          Everything here stays on this device.
        </p>
      </div>
    </div>
  )
}

function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-md border border-[var(--glass-edge)] bg-white/6 px-1.5 py-0.5 font-sans text-[10px] text-[var(--color-text-muted)]">
      {children}
    </kbd>
  )
}
