import { useEffect, useState } from 'react'
import type { SponsorStatus } from '@shared/types/sponsor'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * Sponsored tiles on the start page.
 *
 * Written to be read by a *user*, not an operator: this is the one feature that
 * shows advertising, in a browser sold on blocking it, so the settings copy
 * states exactly what leaves the machine and exactly what does not. Both halves
 * matter — the reassurance is worthless if the cost is not stated beside it.
 */
export function SponsorSection(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const [status, setStatus] = useState<SponsorStatus | null>(null)

  const enabled = settings?.sponsoredTilesEnabled ?? false
  const endpoint = settings?.sponsorEndpoint ?? ''
  const portal = settings?.advertisePortalUrl ?? ''

  const load = (): void => {
    void window.browser.invoke('sponsor:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(load, [enabled, endpoint])

  return (
    <div>
      {/*
        No switch. Sponsored placements are what pays for Slash, and they are
        not optional — that is a deliberate product decision, and the copy below
        states it rather than leaving somebody to find out.

        The *settings* still exist (`sponsoredTilesEnabled` gates the batch
        fetch, `sponsoredNoticesEnabled` the browsing notice). Only the reader's
        controls are gone: whoever publishes the browser still needs to be able
        to turn the network off, and both probes drive those keys.
      */}
      <div className="rounded-xl border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/8 p-3.5">
        <p className="text-[13px] font-medium text-[var(--color-text-primary)]">
          Slash is paid for by sponsored placements
        </p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          Clearly-labelled adverts on the start page — a tile, a banner, cards in the side margins,
          or the whole backdrop — and an occasional notice while you browse. Every one is marked
          Sponsored and names who paid for it. They are how the browser is funded, so they cannot be
          switched off.
        </p>
      </div>

      {/* The honest paragraph. It says what the network actually does, both the
          part that is reassuring and the part that is a cost. */}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Slash downloads a <strong>batch</strong> of adverts every few hours and picks
        one on your machine. That download is the only request: showing a tile sends nothing, the
        images are stored locally rather than loaded from an advertiser, and no browsing data, page
        address or identifier is ever included. What goes back is a count — how many times each
        advert was shown or clicked, per day, and nothing finer.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Nothing about you is part of that download, so the request is identical from every copy of
        Slash. There is no profile behind it because there is nothing to build one from.
      </p>

      {status && (
        <div className="mt-2.5 flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
          {!status.configured && (
            <span>
              No sponsor source is set up, so nothing is shown and no request is made.
            </span>
          )}
          {status.configured && (
            <>
              <span>{status.cached} advert(s) stored on this machine.</span>
              <span>{status.pendingReports} count(s) waiting to be sent.</span>
            </>
          )}
        </div>
      )}

      {/* Operator setting. Deliberately last and plainly labelled — this is for
          whoever is running the browser as a product, not for someone using it. */}
      <details className="mt-3">
        <summary className="cursor-default text-[11px] text-[var(--color-text-muted)]">
          Sponsor source (for whoever publishes this browser)
        </summary>
        <input
          value={endpoint}
          onChange={(event) =>
            void window.browser.invoke('settings:update', { sponsorEndpoint: event.target.value })
          }
          placeholder="https://example.com/slash/tiles.json"
          aria-label="Sponsor endpoint"
          className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              void window.browser.invoke('sponsor:refresh', undefined).then((result) => {
                if (result.ok) setStatus(result.value)
              })
            }}
            className="cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10"
          >
            Fetch now
          </button>
          <button
            type="button"
            onClick={() => {
              void window.browser.invoke('sponsor:clear', undefined).then((result) => {
                if (result.ok) setStatus(result.value)
              })
            }}
            className="cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10"
          >
            Delete stored adverts and counts
          </button>
        </div>

        <label className="mt-3 block text-[11px] text-[var(--color-text-muted)]">
          Where &ldquo;Advertise on Slash&rdquo; points
        </label>
        <input
          value={portal}
          onChange={(event) =>
            void window.browser.invoke('settings:update', {
              advertisePortalUrl: event.target.value
            })
          }
          placeholder="https://ads.example.com"
          aria-label="Advertiser portal address"
          className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          Puts a &ldquo;Post your ad&rdquo; card on the start page for companies wanting to buy the
          placement. Left empty, it falls back to the origin of the sponsor source above — so
          setting this is only needed when the portal lives somewhere else. With neither set,
          nothing is shown and nothing is requested to find that out.
        </p>
      </details>
    </div>
  )
}
