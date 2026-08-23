import { useEffect, useRef } from 'react'
import type { SponsoredTile } from '@shared/types/sponsor'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * The advert that takes over the new-tab backdrop.
 *
 * The premium placement, and the one worth the most: it is the whole page every
 * user sees several times a day, rather than a card competing for a corner of
 * it. Sold **exclusively** — one campaign at a time — which is what makes it
 * worth its rate and keeps the batch every reader downloads to one image.
 *
 * Four rules it follows, none of them decoration:
 *
 *  - **It says it is an advert, in words, with the buyer's name.** A browser
 *    that blocks other people's advertising and disguises its own has no
 *    argument left.
 *  - **A scrim goes over it, always.** The start page has to stay readable over
 *    an image chosen by somebody who has never seen it. The advertiser is
 *    buying attention, not the right to make the browser unusable.
 *  - **Showing it costs no network request.** The image was fetched in a batch
 *    ahead of time and lives on this machine, so an advertiser cannot learn
 *    when or how often it was seen.
 *  - **It is dismissible for the session and switchable off for good**, one
 *    click away in Settings.
 *
 * Renders nothing at all unless the user turned sponsorship on and a background
 * campaign is live, so a default install never sees this.
 */
export function SponsoredBackground({
  creative,
  onDismiss
}: {
  creative: SponsoredTile
  onDismiss: () => void
}): React.JSX.Element {
  const openSettings = useBrowserStore((s) => s.openSettings)
  /** Counted once per creative shown, not once per re-render. */
  const counted = useRef<string | null>(null)

  useEffect(() => {
    if (counted.current === creative.id) return
    counted.current = creative.id
    void window.browser.invoke('sponsor:impression', { tileId: creative.id })
  }, [creative.id])

  const open = (): void => {
    void window.browser.invoke('sponsor:click', { tileId: creative.id })
  }

  return (
    <>
      {/*
        The image itself. `pointer-events-none` so it never swallows a click
        meant for the omnibox — the clickable surface is the labelled strip
        below, not the entire page. An advert that turns the whole start page
        into a link is a trap, whatever it earns.
      */}
      {creative.image !== '' && (
        <div
          aria-hidden="true"
          className="animate-rise pointer-events-none absolute inset-0"
          style={{
            backgroundImage: `url(${creative.image})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        />
      )}

      {/*
        Readability, not taste. The page's own text sits over an image the
        advertiser chose, and it has to remain legible whatever they picked.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(8,10,16,0.72) 0%, rgba(8,10,16,0.55) 38%, rgba(8,10,16,0.86) 100%)'
        }}
      />

      {/* The label and the click target, pinned to the bottom. */}
      <div className="animate-rise pointer-events-none absolute inset-x-0 bottom-0 z-10 p-4">
        <div className="glass-float pointer-events-auto mx-auto flex max-w-3xl items-center gap-3 rounded-xl px-3.5 py-2.5">
          <button
            type="button"
            onClick={open}
            className="flex min-w-0 flex-1 cursor-default items-center gap-3 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="rounded bg-white/12 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
                  Sponsored
                </span>
                <span className="truncate text-[11px] text-[var(--color-text-muted)]">
                  {creative.sponsor}
                </span>
              </span>
              <span className="mt-1 block truncate text-[14px] font-medium">
                {creative.headline}
              </span>
              {creative.body !== '' && (
                <span className="mt-0.5 block truncate text-[12px] text-[var(--color-text-muted)]">
                  {creative.body}
                </span>
              )}
            </span>
          </button>

          <button
            type="button"
            onClick={onDismiss}
            title="Hide until the next time you open Slash"
            className="shrink-0 cursor-default rounded-md border border-[var(--glass-edge)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Hide
          </button>
          <button
            type="button"
            onClick={openSettings}
            title="Turn sponsored backgrounds off"
            className="shrink-0 cursor-default rounded-md border border-[var(--glass-edge)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Turn off
          </button>
        </div>
      </div>
    </>
  )
}
