import { useEffect, useRef } from 'react'
import type { SponsoredTile } from '@shared/types/sponsor'

/**
 * The wide sponsored panel on the start page.
 *
 * Between the tile and the full backdrop: visible without owning the page, and
 * priced accordingly. It carries the advertiser's image as its own background
 * rather than the page's, so a banner campaign and a backdrop campaign can run
 * at the same time without fighting each other.
 */
export function SponsoredBanner({ creative }: { creative: SponsoredTile }): React.JSX.Element {
  const counted = useRef<string | null>(null)

  useEffect(() => {
    if (counted.current === creative.id) return
    counted.current = creative.id
    void window.browser.invoke('sponsor:impression', { tileId: creative.id })
  }, [creative.id])

  return (
    <section className="animate-rise mt-8 w-full">
      <button
        type="button"
        onClick={() => void window.browser.invoke('sponsor:click', { tileId: creative.id })}
        className="glass-raised relative block w-full cursor-default overflow-hidden rounded-2xl text-left transition hover:brightness-110"
        style={{ minHeight: 132 }}
      >
        {creative.image !== '' && (
          <span
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${creative.image})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }}
          />
        )}
        {/* The advertiser picked the image; the text still has to be readable. */}
        <span
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(8,10,16,0.9) 0%, rgba(8,10,16,0.72) 55%, rgba(8,10,16,0.45) 100%)'
          }}
        />
        <span className="relative block p-5">
          <span className="flex items-center gap-2">
            <span className="rounded bg-white/12 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
              Sponsored
            </span>
            <span className="truncate text-[11px] text-[var(--color-text-muted)]">
              {creative.sponsor}
            </span>
          </span>
          <span className="mt-2 block text-[18px] leading-snug font-semibold">
            {creative.headline}
          </span>
          {creative.body !== '' && (
            <span className="mt-1 block text-[13px] text-[var(--color-text-muted)]">
              {creative.body}
            </span>
          )}
        </span>
      </button>
    </section>
  )
}
