import { useEffect, useRef, useState } from 'react'
import type { SponsorStatus } from '@shared/types/sponsor'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * The one place Slash shows advertising.
 *
 * Three rules it follows, none of which is decoration:
 *
 *  - **It says it is an advert, in words, always.** Not a faint corner marker —
 *    a label with the sponsor's name beside it. A browser that blocks other
 *    people's advertising and disguises its own has no argument left.
 *  - **Showing it costs no network request.** The creative and its image were
 *    fetched in a batch ahead of time and live on this machine, so a sponsor
 *    cannot learn when or how often a tile was seen.
 *  - **It is dismissible and switchable off**, and the switch is one click away
 *    in Settings rather than buried.
 *
 * Renders nothing at all unless the user turned it on and a creative is cached,
 * so the default install never sees this.
 */
export function SponsoredTile(): React.JSX.Element | null {
  const [status, setStatus] = useState<SponsorStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const openSettings = useBrowserStore((s) => s.openSettings)
  /** Counted once per tile shown, not once per re-render. */
  const counted = useRef<string | null>(null)

  useEffect(() => {
    const read = (): void => {
      void window.browser.invoke('sponsor:status', undefined).then((result) => {
        if (result.ok) setStatus(result.value)
      })
    }
    read()
    // Same reason as the page around it: mounted long before any batch exists.
    return window.browser.on('sponsor:changed', read)
  }, [])

  const tile = status?.tile ?? null

  useEffect(() => {
    if (!tile || dismissed || counted.current === tile.id) return
    counted.current = tile.id
    void window.browser.invoke('sponsor:impression', { tileId: tile.id })
  }, [tile, dismissed])

  if (!tile || dismissed) return null

  return (
    <section className="animate-rise mt-8 w-full">
      <div className="glass-raised relative overflow-hidden rounded-2xl">
        <button
          type="button"
          onClick={() => void window.browser.invoke('sponsor:click', { tileId: tile.id })}
          className="flex w-full cursor-default items-center gap-4 p-4 text-left transition hover:bg-[var(--glass-high)]"
        >
          {tile.image !== '' && (
            // Always a data: URL — the main process drops any creative whose
            // image is remote, because that would be a per-impression request
            // to the sponsor and a tracking pixel in all but name.
            <img
              src={tile.image}
              alt=""
              className="size-12 shrink-0 rounded-xl object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none'
              }}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
                Sponsored
              </span>
              <span className="truncate text-[11px] text-[var(--color-text-muted)]">
                {tile.sponsor}
              </span>
            </span>
            <span className="mt-1.5 block truncate text-[14px] font-medium">{tile.headline}</span>
            {tile.body !== '' && (
              <span className="mt-0.5 block truncate text-[12px] text-[var(--color-text-muted)]">
                {tile.body}
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          aria-label="Hide this sponsored tile"
          title="Hide"
          onClick={() => setDismissed(true)}
          className="absolute top-2.5 right-2.5 cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/15 hover:text-[var(--color-text-primary)]"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
        Chosen on this device — no browsing data was sent to show it.{' '}
        <button
          type="button"
          onClick={openSettings}
          className="cursor-default underline decoration-dotted underline-offset-2 hover:text-[var(--color-text-primary)]"
        >
          Turn off
        </button>
      </p>
    </section>
  )
}
