import { useEffect, useRef, useState } from 'react'
import type { SponsoredTile } from '@shared/types/sponsor'

/**
 * A sponsored notice, shown while somebody is browsing.
 *
 * In the **overlay** — the browser's own surface — and never inside the page.
 * A sponsored strip injected into whatever site somebody is reading is exactly
 * what Slash Shield blocks on their behalf, and doing it ourselves would make
 * this browser adware rather than a browser that blocks adware.
 *
 * Its overlay is a small strip and deliberately not modal, so the page
 * underneath stays fully clickable while this is up. It closes itself; a
 * sponsored message that has to be dismissed is an interruption rather than a
 * notice.
 */
export function SponsorNotice(): React.JSX.Element | null {
  const [creative, setCreative] = useState<SponsoredTile | null>(null)
  const counted = useRef<string | null>(null)

  const close = (): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }

  useEffect(() => {
    void window.browser.invoke('sponsor:currentNotice', undefined).then((result) => {
      if (result.ok) setCreative(result.value)
    })
  }, [])

  useEffect(() => {
    if (!creative || counted.current === creative.id) return
    counted.current = creative.id
    void window.browser.invoke('sponsor:impression', { tileId: creative.id })
  }, [creative])

  useEffect(() => {
    if (!creative) return
    // Long enough to read and act on, short enough not to sit over somebody's
    // work. It is an advert, not a dialog.
    const timer = setTimeout(close, 12_000)
    return () => clearTimeout(timer)
  }, [creative])

  if (!creative) return null

  return (
    <div className="flex h-full w-full items-end justify-center p-3">
      <div className="glass-float animate-rise w-full rounded-xl p-3">
        <div className="flex items-start gap-3">
          {creative.image !== '' && (
            <img
              src={creative.image}
              alt=""
              className="size-11 shrink-0 rounded-lg object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none'
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              void window.browser.invoke('sponsor:click', { tileId: creative.id })
              close()
            }}
            className="min-w-0 flex-1 cursor-default text-left"
          >
            <span className="flex items-center gap-2">
              <span className="rounded bg-white/12 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
                Sponsored
              </span>
              <span className="truncate text-[10px] text-[var(--color-text-muted)]">
                {creative.sponsor}
              </span>
            </span>
            <span className="mt-1 block truncate text-[13px] font-medium">{creative.headline}</span>
            {creative.body !== '' && (
              <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">
                {creative.body}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={close}
            className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/15"
          >
            ✕
          </button>
        </div>
        <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
          Shown at most a few times a day. Turn these off in Settings → Earning.
        </p>
      </div>
    </div>
  )
}
