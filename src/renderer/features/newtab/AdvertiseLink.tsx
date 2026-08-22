import { useEffect, useState } from 'react'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * "Advertise on Slash", for the people who buy the tile above it.
 *
 * Shown only when an operator has set `advertisePortalUrl`, so a default
 * install never sees it — and when it is shown it is a line, not a panel.
 * Principle 6: the start page belongs to whoever opened the tab, and a browser
 * that starts advertising its own advertising has begun to become the thing it
 * blocks.
 *
 * Costs no network request. The address is a local setting, so nothing is
 * looked up to decide whether to draw this.
 */
export function AdvertiseLink(): React.JSX.Element | null {
  const url = useBrowserStore((s) => s.settings?.advertisePortalUrl) ?? ''
  // The publisher's switch, on top of the local address -- this is what makes
  // the operations app's "Browser config" page control something. Defaults to
  // shown, so an unreachable config server never silently removes the link.
  const [allowed, setAllowed] = useState(true)

  useEffect(() => {
    void window.browser.invoke('config:remote', undefined).then((result) => {
      if (result.ok) setAllowed(result.value.showAdvertiseCta)
    })
    return window.browser.on('config:changed', (config) => setAllowed(config.showAdvertiseCta))
  }, [])

  if (!allowed) return null
  if (url === '' || !/^https?:\/\//i.test(url)) return null

  return (
    <p className="mt-3 text-center text-[11px] text-[var(--color-text-muted)]">
      <button
        type="button"
        onClick={() => void window.browser.invoke('tabs:create', { url, background: false })}
        className="cursor-default underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-text-primary)]"
      >
        Advertise on Slash
      </button>
    </p>
  )
}
