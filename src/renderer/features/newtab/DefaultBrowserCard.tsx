import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'

/**
 * The offer to become the default browser, for people past the walkthrough.
 *
 * On the start page rather than as a bar over the content, for the usual
 * reason: the page view is a native layer composited above the chrome document,
 * so anything drawn over a real page has to live in the overlay — and the
 * overlay is for things the user asked for, not for advertising a setting.
 *
 * Whether to show it is main's decision, not this component's
 * (`shouldOfferDefault`): twice, a fortnight apart, and never once somebody has
 * said no. A renderer that decides when to nag is a renderer that nags again
 * after every reload.
 */
export function DefaultBrowserCard(): React.JSX.Element | null {
  const [offer, setOffer] = useState(false)
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    void window.browser.invoke('system:defaultBrowser', undefined).then((result) => {
      if (result.ok) setOffer(result.value.shouldOffer)
    })
  }, [])

  if (!offer) return null

  return (
    <section className="mt-6 rounded-2xl border border-[var(--color-border-subtle)] bg-white/[0.03] p-4">
      <div className="flex items-start gap-3">
        <Icon name="globe" size={18} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Make Slash your default browser</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            {opened
              ? 'Find Slash in the list Windows opened and set it for http and https. Windows requires that click to happen there.'
              : 'Links from mail, chat and documents would open here. Windows does not let an application make itself the default, so this opens the Settings screen where you can choose Slash.'}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setOpened(true)
                void window.browser.invoke('system:openDefaultBrowserSettings', undefined)
              }}
              className="cursor-pointer rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-black transition hover:opacity-90"
            >
              Open Windows settings
            </button>
            <button
              type="button"
              onClick={() => {
                setOffer(false)
                void window.browser.invoke('system:dismissDefaultBrowser', { forever: false })
              }}
              className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
            >
              Not now
            </button>
            {/* An explicit way out. Without one, "not now" is the only answer
                available and the card comes back — which is how a prompt turns
                into the reason somebody stops opening a new tab. */}
            <button
              type="button"
              onClick={() => {
                setOffer(false)
                void window.browser.invoke('system:dismissDefaultBrowser', { forever: true })
              }}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
            >
              Don&apos;t ask again
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
