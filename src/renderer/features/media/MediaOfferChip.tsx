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

  if (!offer) return null

  return (
    <div className="flex h-full w-full items-start justify-end p-2">
      <div className="glass-float animate-rise w-full rounded-xl p-2.5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
            <Icon name="video" size={17} />
          </span>

          <div className="min-w-0 flex-1">
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
