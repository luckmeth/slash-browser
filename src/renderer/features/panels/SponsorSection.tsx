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

  const load = (): void => {
    void window.browser.invoke('sponsor:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(load, [enabled, endpoint])

  return (
    <div>
      <label className="flex cursor-default items-start justify-between gap-2 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2">
        <span className="min-w-0">
          <span className="block text-xs">Show a sponsored tile</span>
          <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-text-muted)]">
            One clearly-labelled tile on the start page, which helps pay for Slash.
          </span>
        </span>
        <input
          type="checkbox"
          className="mt-0.5 shrink-0"
          checked={enabled}
          onChange={(event) =>
            void window.browser.invoke('settings:update', {
              sponsoredTilesEnabled: event.target.checked
            })
          }
        />
      </label>

      {/* The honest paragraph. It says what the network actually does, both the
          part that is reassuring and the part that is a cost. */}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        With this on, Slash downloads a <strong>batch</strong> of adverts every few hours and picks
        one on your machine. That download is the only request: showing a tile sends nothing, the
        images are stored locally rather than loaded from an advertiser, and no browsing data, page
        address or identifier is ever included. What goes back is a count — how many times each
        advert was shown or clicked, per day, and nothing finer.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        With it off, no request is made at all.
      </p>

      {status && (
        <div className="mt-2.5 flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
          {!status.configured && (
            <span>
              No sponsor source is set up, so nothing will be shown even when this is switched on.
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
      </details>
    </div>
  )
}
