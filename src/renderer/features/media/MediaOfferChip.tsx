import { useEffect, useState } from 'react'
import type { InvokeResponse } from '@shared/ipc/contracts'
import { Icon } from '../../components/Icon'

type Offer = NonNullable<InvokeResponse<'media:offer'>>

/**
 * "There is a video here you can download", floating over the page.
 *
 * The affordance a download manager is recognised by. It has to be here, in the
 * overlay: the page is a native `WebContentsView` composited above the chrome
 * document, so a chip drawn in React would render *behind* the video it is
 * pointing at — visible on the new tab page and invisible on YouTube, which is
 * the worst possible way for a feature to appear to work.
 *
 * Its overlay is a chip in the corner and **not modal**, so the video stays
 * clickable underneath. That is not a nicety: overlay hit-testing is
 * rectangular, and a full-window surface would make the player inert for as
 * long as the offer was up.
 *
 * One file, not a list. This is a single-click thing over something somebody is
 * watching; anybody who wants to choose between four files opens the panel, and
 * a menu floating over a playing video is worse than the button they wanted.
 */
export function MediaOfferChip(): React.JSX.Element | null {
  const [offer, setOffer] = useState<Offer | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = (): void => {
    void window.browser.invoke('media:offer', undefined).then((result) => {
      if (!result.ok) return
      setOffer(result.value)
      setSaving(false)
    })
  }

  useEffect(refresh, [])

  // The overlay document stays mounted while the surface is unchanged, so
  // playing the next video would leave this pointing at the previous file —
  // showing the right chip for the wrong video, which is worse than no chip.
  useEffect(() => window.browser.on('media:found', refresh), [])

  /*
   * Dragging the chip.
   *
   * The chip is a native `WebContentsView` that main repositions, so the view
   * moves *under the cursor* as it goes. That rules out measuring a position
   * inside the view — by the time the next event arrives the view has moved and
   * the offset is against a frame that no longer exists, which makes the chip
   * run away from the pointer.
   *
   * `screenX`/`screenY` do not care where the view is, so successive deltas
   * compose correctly however far it has travelled. Main clamps the result.
   *
   * Throttled to one message per animation frame: a pointermove can fire far
   * more often than the compositor draws, and this is IPC on a gesture over a
   * playing video.
   */
  const startDrag = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    /*
     * Capture is a nicety, not the mechanism.
     *
     * It keeps the grip receiving moves if the pointer briefly outruns the
     * view, but it throws for a pointer id the browser is not tracking — and a
     * throw here would abort before the window listeners below are attached,
     * killing the gesture with nothing to show for it. The drag works without
     * it, so it is attempted and not depended on.
     */
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Nothing to do; the window listeners below carry the drag.
    }

    let lastX = event.screenX
    let lastY = event.screenY
    let queued: { dx: number; dy: number } | null = null
    let frame = 0

    const flush = (final = false): void => {
      frame = 0
      if (!queued && !final) return
      const { dx, dy } = queued ?? { dx: 0, dy: 0 }
      queued = null
      // `final` is what makes main write the position to settings — once, at
      // the end, rather than on every frame of the gesture.
      void window.browser.invoke('media:moveOffer', { dx, dy, final })
    }

    const onMove = (move: PointerEvent): void => {
      const dx = move.screenX - lastX
      const dy = move.screenY - lastY
      if (dx === 0 && dy === 0) return
      lastX = move.screenX
      lastY = move.screenY
      queued = queued ? { dx: queued.dx + dx, dy: queued.dy + dy } : { dx, dy }
      // Wrapped rather than passed directly: rAF hands its callback a
      // timestamp, which would arrive as `final` and persist on every frame.
      if (frame === 0) frame = requestAnimationFrame(() => flush())
    }

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // Whatever was still queued when the button came up, so the chip ends
      // where the pointer did rather than a frame behind it.
      if (frame !== 0) cancelAnimationFrame(frame)
      flush(true)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  if (!offer) return null

  return (
    <div className="flex h-full w-full items-start justify-end p-2">
      <div className="glass-float animate-rise w-full rounded-xl p-2.5">
        <div className="flex items-center gap-2.5">
          {/*
            The grip, and the whole of what starts a drag.
            Deliberately not the whole chip: the filename is worth selecting and
            the buttons are worth clicking, and a card that moves whenever you
            press it anywhere makes both of those a gamble.
          */}
          <span
            onPointerDown={startDrag}
            title="Drag to move"
            aria-label="Drag to move"
            role="button"
            tabIndex={-1}
            className="grid size-9 shrink-0 cursor-grab touch-none place-items-center rounded-lg bg-[var(--color-accent)]/15 text-[var(--color-accent)] active:cursor-grabbing"
          >
            <Icon name="video" size={17} />
          </span>

          {/*
            The title block drags too. The grip alone is a 36px target for a
            gesture whose whole point is getting the chip out of the way, and
            the buttons beside it stay clickable because the drag starts on
            these two elements only.
          */}
          <div
            onPointerDown={startDrag}
            className="min-w-0 flex-1 cursor-grab touch-none select-none active:cursor-grabbing"
          >
            <p className="truncate text-xs font-medium" title={offer.filename}>
              {offer.filename}
            </p>
            <p className="truncate text-[11px] text-[var(--color-text-muted)]">
              {offer.sizeText}
              {offer.others > 0 && ` · ${offer.others} more in Downloads`}
            </p>
          </div>

          {/*
            Opens the picker rather than downloading blind. On a page that lists
            several qualities there is no single right answer, and on YouTube
            there is no file at all until the page has been read — so one button
            labelled "Download" would have been a promise about something the
            browser had not looked at yet.
          */}
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true)
              void window.browser.invoke('media:openPicker', undefined)
            }}
            className="shrink-0 cursor-pointer rounded-lg bg-[var(--color-accent)] px-2.5 py-1.5 text-[11px] font-medium text-black transition hover:opacity-90 disabled:opacity-60"
          >
            {saving ? 'Opening…' : 'Download'}
          </button>

          {/* Dismissal is per page, not forever — see `dismissMediaOffer`.
              Dismissing one video is not a statement about every video. */}
          <button
            type="button"
            aria-label="Not now"
            title="Not now"
            onClick={() => {
              setOffer(null)
              void window.browser.invoke('media:dismissOffer', undefined)
            }}
            className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
