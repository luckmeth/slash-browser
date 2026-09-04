import { useEffect, useRef, useState } from 'react'
import type { SponsoredTile } from '@shared/types/sponsor'

/**
 * A card in the gutter beside the start page's content column.
 *
 * The content column is capped at `max-w-3xl` and centred, so on any window
 * wider than about 1100px there are a few hundred pixels doing nothing on each
 * side. That is the space this uses — inventory that costs the reader nothing,
 * because it was already blank.
 *
 * Which is also why it is the first thing to go: below the width where the
 * gutter would start crowding the column, it renders nothing at all rather
 * than squeezing in beside the content. An advert that makes the page it sits
 * on worse is not worth the money.
 */
export function SponsoredRail({
  creative,
  side
}: {
  creative: SponsoredTile
  side: 'left' | 'right'
}): React.JSX.Element | null {
  const counted = useRef<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [wideEnough, setWideEnough] = useState(false)

  // The column is 768px and needs breathing room; below this the gutter is not
  // wide enough for a card that anybody could read.
  useEffect(() => {
    const query = globalThis.matchMedia?.('(min-width: 1180px)')
    if (!query) return
    setWideEnough(query.matches)
    const onChange = (event: MediaQueryListEvent): void => setWideEnough(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // Counted only when it is genuinely on screen. A creative that never rendered
  // because the window was narrow must not be billed as an impression.
  useEffect(() => {
    if (!wideEnough || dismissed) return
    if (counted.current === creative.id) return
    counted.current = creative.id
    void window.browser.invoke('sponsor:impression', { tileId: creative.id })
  }, [creative.id, wideEnough, dismissed])

  if (!wideEnough || dismissed) return null

  return (
    <aside
      className={`animate-rise pointer-events-auto absolute top-[18vh] hidden w-[236px] xl:block ${
        side === 'left' ? 'left-6' : 'right-6'
      }`}
      aria-label={`Sponsored by ${creative.sponsor}`}
    >
      <div className="glass-raised relative overflow-hidden rounded-2xl">
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hide this advert"
          className="absolute top-2 right-2 z-10 cursor-default rounded-md bg-black/40 px-1.5 py-0.5 text-[11px] text-white/70 transition hover:text-white"
        >
          ×
        </button>

        <button
          type="button"
          onClick={() => void window.browser.invoke('sponsor:click', { tileId: creative.id })}
          className="block w-full cursor-default text-left transition hover:brightness-110"
        >
          {creative.image !== '' && (
            <span
              aria-hidden="true"
              className="block h-[132px] w-full"
              style={{
                backgroundImage: `url(${creative.image})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}
            />
          )}
          <span className="block p-3.5">
            <span className="flex items-center gap-1.5">
              <span className="rounded bg-white/12 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
                Sponsored
              </span>
              <span className="truncate text-[10px] text-[var(--color-text-muted)]">
                {creative.sponsor}
              </span>
            </span>
            <span className="mt-2 block text-[14px] leading-snug font-semibold">
              {creative.headline}
            </span>
            {creative.body !== '' && (
              <span className="mt-1 block text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                {creative.body}
              </span>
            )}
          </span>
        </button>
      </div>
    </aside>
  )
}
