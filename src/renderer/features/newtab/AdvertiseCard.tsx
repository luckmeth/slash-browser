import { useEffect, useState } from 'react'
import { originOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
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
  const configured = useBrowserStore((s) => s.settings?.advertisePortalUrl) ?? ''
  const sponsorEndpoint = useBrowserStore((s) => s.settings?.sponsorEndpoint) ?? ''
  const [allowed, setAllowed] = useState(true)

  /**
   * The portal address, or the origin of the sponsor endpoint.
   *
   * An operator who has configured `https://ads.example.com/api/tiles` has
   * already told us where the portal is; making them type the same origin into
   * a second box is a step whose only possible outcomes are "the same answer"
   * and "a typo". Setting `advertisePortalUrl` explicitly still wins, for the
   * deployment where the two genuinely differ.
   */
  const url =
    configured !== ''
      ? configured
      : sponsorEndpoint !== ''
        ? originOf(sponsorEndpoint)
        : ''

  useEffect(() => {
    void window.browser.invoke('config:remote', undefined).then((result) => {
      if (result.ok) setAllowed(result.value.showAdvertiseCta)
    })
    return window.browser.on('config:changed', (config) => setAllowed(config.showAdvertiseCta))
  }, [])

  if (!allowed) return null
  if (url === '' || !/^https?:\/\//i.test(url)) return null

  return (
    <button
      type="button"
      onClick={() => void window.browser.invoke('tabs:create', { url, background: false })}
      className="glass-raised animate-rise mt-8 flex w-full cursor-default items-center gap-4 rounded-2xl border border-[var(--glass-edge)] p-4 text-left transition hover:border-[var(--color-accent)]"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
        <Icon name="sparkle" size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">Post your ad — reach every Slash user</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-[var(--color-text-muted)]">
          Your brand on the start page of every session. Bought by the hour, live within a day, no
          agency and no bidding.
        </span>
      </span>
      <Icon name="external" size={14} className="shrink-0 text-[var(--color-text-muted)]" />
    </button>
  )
}
