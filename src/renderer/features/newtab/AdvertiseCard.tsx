import { useEffect, useState } from 'react'
import { ADVERTISE_URL } from '@shared/types/tab'
import { Icon } from '../../components/Icon'

/**
 * "Post your ad" — the entry point companies arrive through.
 *
 * This is the top of the revenue funnel, and it is the only place a company
 * that has never heard of the advertising product will ever encounter it. It
 * replaces a single underlined line of text, which was findable only by someone
 * already looking for it.
 *
 * Still gated twice, and gated hard:
 *
 *  - **An address must be configured.** Empty on a fresh install, so a default
 *    build shows nothing and makes no request to find that out.
 *  - **The publisher can switch it off remotely** without shipping a version.
 *
 * Deliberately below the fold-ish content and quiet in tone. Principle 6: the
 * start page belongs to whoever opened the tab, and a browser that starts
 * advertising its own advertising has begun to become the thing it blocks.
 */
export function AdvertiseCard(): React.JSX.Element | null {
  const [allowed, setAllowed] = useState(true)



  useEffect(() => {
    void window.browser.invoke('config:remote', undefined).then((result) => {
      if (result.ok) setAllowed(result.value.showAdvertiseCta)
    })
    return window.browser.on('config:changed', (config) => setAllowed(config.showAdvertiseCta))
  }, [])

  // The publisher's remote switch still applies. The *portal* requirement does
  // not any more: this now opens an internal page that explains the placements
  // and the rates, which exists in every build. A company that has just noticed
  // the card should be able to read the price list without the operator having
  // configured anything, and the page itself says plainly when there is no
  // portal to send a request to.
  if (!allowed) return null

  return (
    <button
      type="button"
      onClick={() => void window.browser.invoke('tabs:create', { url: ADVERTISE_URL, background: false })}
      className="glass-raised animate-rise mt-8 flex w-full cursor-default items-center gap-4 rounded-2xl border border-[var(--glass-edge)] p-4 text-left transition hover:border-[var(--color-accent)]"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
        <Icon name="sparkle" size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">Post your ad — reach every Slash user</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-[var(--color-text-muted)]">
          Book it here in a few minutes — company details once, then choose a placement and dates.
          Bought by the hour, reviewed by a person, and you are not charged until it is approved.
        </span>
      </span>
      {/* Not `external`: booking happens on a page inside the browser now, and
          an icon promising a new site is a small lie told on the start page. */}
      <Icon name="forward" size={14} className="shrink-0 text-[var(--color-text-muted)]" />
    </button>
  )
}
