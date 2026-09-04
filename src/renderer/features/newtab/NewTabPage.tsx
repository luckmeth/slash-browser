import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@shared/types/browsing'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { BrandMark } from '../../components/BrandMark'
import { Icon } from '../../components/Icon'
import { RecentlyClosed } from './RecentlyClosed'
import type { SponsoredTile as SponsoredCreative } from '@shared/types/sponsor'
import { SponsoredTile } from './SponsoredTile'
import { AdvertiseCard } from './AdvertiseCard'
import { RewardsCard } from './RewardsCard'
import { DefaultBrowserCard } from './DefaultBrowserCard'
import { SponsoredBackground } from './SponsoredBackground'
import { SponsoredBanner } from './SponsoredBanner'
import { SponsoredRail } from './SponsoredRail'
import { PublisherNotice } from './PublisherNotice'
import { backgroundCss } from './backgrounds'

/**
 * The start page.
 *
 * Rendered by the chrome document in the hole where a page view would be, which
 * is why it can read history and workspaces over the existing IPC surface
 * without registering a scheme or granting a page view any privileges.
 *
 * This is the screen seen most often, so it is the argument for the browser.
 * Everything on it is either a real recorded number or something the user put
 * there — nothing is projected, and a section with nothing to say renders
 * nothing rather than an empty heading.
 */
export function NewTabPage(): React.JSX.Element {
  const [topSites, setTopSites] = useState<HistoryEntry[]>([])
  const [customBackground, setCustomBackground] = useState<string | null>(null)
  const requestOmniboxFocus = useBrowserStore((s) => s.requestOmniboxFocus)
  const activeTabId = useBrowserStore((s) => s.activeTab()?.id ?? null)
  const [draft, setDraft] = useState('')
  const workspaces = useBrowserStore((s) => s.workspaces)
  const activeWorkspaceId = useBrowserStore((s) => s.activeWorkspaceId)
  const tabs = useBrowserStore((s) => s.tabs)
  const settings = useBrowserStore((s) => s.settings)

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const backgroundId = settings?.newTabBackground ?? 'aurora'
  /**
   * The campaign taking over the backdrop, if one is live.
   *
   * Dismissal lasts the session only. Persisting it would mean an advertiser
   * paying for hours that one reader had already opted out of, which is a
   * different product from the one being sold — and the switch that turns it
   * off for good is two clicks away in Settings.
   */
  const [sponsoredBackground, setSponsoredBackground] = useState<SponsoredCreative | null>(null)
  const [sponsoredBanner, setSponsoredBanner] = useState<SponsoredCreative | null>(null)
  const [sponsoredRails, setSponsoredRails] = useState<SponsoredCreative[]>([])
  const [backgroundDismissed, setBackgroundDismissed] = useState(false)

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

  // Only asked for when it is actually going to be used. The image is read in
  // main and returned as a data URL, so this document never holds a path.
  useEffect(() => {
    if (backgroundId !== 'custom') {
      setCustomBackground(null)
      return
    }
    void window.browser.invoke('newtab:backgroundImage', undefined).then((result) => {
      setCustomBackground(result.ok ? result.value : null)
    })
  }, [backgroundId, settings?.newTabCustomBackground])

  useEffect(() => {
    const read = (): void => {
      void window.browser.invoke('sponsor:status', undefined).then((result) => {
        if (!result.ok) return
        setSponsoredBackground(result.value.background)
        setSponsoredBanner(result.value.banner)
        setSponsoredRails(result.value.rails)
      })
    }
    read()
    // Read once on mount was not enough, and the gap was invisible because it
    // only showed on a placement somebody had paid for. This page is drawn by
    // the chrome document, which mounts at launch — before any batch has been
    // fetched — so a batch arriving seconds later never reached it and the
    // banner and background stayed empty until the next restart.
    return window.browser.on('sponsor:changed', read)
  }, [])

  const background = backgroundCss(backgroundId, customBackground)
  // A paid takeover replaces the user's chosen backdrop for its window; both
  // being drawn would leave the advertiser's image fighting a gradient.
  const showSponsoredBackground = sponsoredBackground !== null && !backgroundDismissed

  return (
    <div className="glass-page relative h-full overflow-y-auto">
      {/* Backdrop. CSS gradients rather than bundled photographs — an image set
          worth looking at would add tens of megabytes to the installer, and
          fetching one would make opening a tab an outbound request. */}
      {!showSponsoredBackground && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background,
            backgroundSize: backgroundId === 'custom' ? 'cover' : undefined,
            backgroundPosition: backgroundId === 'custom' ? 'center' : undefined
          }}
        />
      )}

      {showSponsoredBackground && (
        <SponsoredBackground
          creative={sponsoredBackground}
          onDismiss={() => setBackgroundDismissed(true)}
        />
      )}
      {/* A scrim under the content when a photograph is behind it, so text stays
          legible whatever the user picked. Not applied to the gradients, which
          are already low-contrast by construction. */}
      {!showSponsoredBackground && backgroundId === 'custom' && customBackground && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: 'linear-gradient(180deg, rgba(8,10,16,0.55), rgba(8,10,16,0.75))' }}
        />
      )}

      {/* The gutters. Positioned against the scrolling container rather than
          inside the column, so they occupy the space the column does not use
          instead of narrowing it. */}
      {sponsoredRails[0] && <SponsoredRail creative={sponsoredRails[0]} side="left" />}
      {sponsoredRails[1] && <SponsoredRail creative={sponsoredRails[1]} side="right" />}

      <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center px-8 pt-[12vh] pb-16">
        <div className="animate-rise flex flex-col items-center">
          <BrandMark size={50} className="text-[var(--color-text-primary)]" />
          <h1 className="mt-4 text-[26px] leading-none font-semibold tracking-tight">
            {greeting()}
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

        {/*
          A real input, not a button that redirects focus.

          It used to be a button whose only job was to focus the omnibox at the
          top — reasonable in principle, since duplicating suggestions and URL
          resolution would be worse, but in practice you click a search box and
          nothing you type appears in it. Typing here now navigates, using the
          same resolver the omnibox uses, so the two agree about what "wiki" or
          "example.com/x" means. Suggestions stay in the omnibox: Ctrl+L is one
          key away and is still shown on the right.
        */}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const query = draft.trim()
            if (query === '' || !activeTabId) return
            setDraft('')
            // The same channel the omnibox uses for typed text, so the two
            // agree about what "wiki" or "example.com/x" resolves to.
            void window.browser.invoke('nav:navigate', { tabId: activeTabId, input: query })
          }}
          className="glass-raised animate-rise mt-8 flex w-full max-w-xl items-center gap-3 rounded-2xl px-4 py-3 transition focus-within:border-[var(--glass-edge-strong)]"
        >
          <Icon name="search" size={16} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search or enter address"
            aria-label="Search or enter address"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]"
          />
          <button
            type="button"
            onClick={requestOmniboxFocus}
            title="Use the address bar, which also offers suggestions"
            className="ml-auto flex shrink-0 cursor-pointer items-center gap-1"
          >
            <Key>Ctrl</Key>
            <Key>L</Key>
          </button>
        </form>

        {/*
          The counters and the restore-point list used to sit here. Both were
          removed on purpose: "15 blocked, 3 restore points" is a dashboard, and
          a new tab is a place you pass through on the way somewhere — what
          belongs under the search box is the two things that get you there,
          which are the sites you actually visit and the tab you just closed.
          The dashboard still exists behind the panels for anyone who wants it.
        */}
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

        <RecentlyClosed />

        <PublisherNotice />
        {sponsoredBanner && <SponsoredBanner creative={sponsoredBanner} />}
        <SponsoredTile />
        <DefaultBrowserCard />
        <RewardsCard />
        <AdvertiseCard />



        <div className="flex-1" />

        {/*
          Narrowed from "everything here stays on this device", which was true
          until sponsored placements became always-on and the browser began
          fetching advert batches without being asked. What is left is the part
          that is still exactly true.
        */}
        <p className="mt-10 text-[11px] text-[var(--color-text-muted)]">
          Your history and bookmarks stay on this device.
        </p>
      </div>
    </div>
  )
}

/**
 * Time-of-day greeting.
 *
 * Read from the machine's own clock, which is the only place it could come
 * from — there is no location lookup and no request behind this.
 */
function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-md border border-[var(--glass-edge)] bg-white/6 px-1.5 py-0.5 font-sans text-[10px] text-[var(--color-text-muted)]">
      {children}
    </kbd>
  )
}
