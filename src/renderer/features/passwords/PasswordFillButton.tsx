import { useEffect, useState } from 'react'
import { isInternalUrl } from '@shared/types/tab'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * Appears only when the page in front of you has a sign-in form.
 *
 * A permanent key icon would be clutter on the ninety-nine pages out of a
 * hundred that have nothing to fill, and — worse — it would suggest Slash is
 * watching sign-in fields everywhere. It is shown exactly when the content
 * preload has reported a password field on this document, and it disappears
 * when you navigate away.
 *
 * It opens an overlay surface rather than a dropdown, because a dropdown drawn
 * in the chrome document is composited underneath the native page view.
 */
export function PasswordFillButton(): React.JSX.Element | null {
  const activeTab = useBrowserStore((s) => s.activeTab())
  const [offer, setOffer] = useState<{ hasForm: boolean; count: number }>({
    hasForm: false,
    count: 0
  })

  const tabId = activeTab?.id ?? null
  const url = activeTab?.url ?? ''

  useEffect(() => {
    if (!tabId || isInternalUrl(url)) {
      setOffer({ hasForm: false, count: 0 })
      return
    }
    const load = (): void => {
      void window.browser.invoke('vault:formForTab', { tabId }).then((result) => {
        if (!result.ok) return
        setOffer({
          hasForm: result.value.form.hasPasswordField,
          count: result.value.matches.length
        })
      })
    }
    load()
    // Sign-in forms often arrive after the initial load — a modal, a route
    // change — so this is re-checked while the page settles rather than once.
    const timer = setInterval(load, 1500)
    return () => clearInterval(timer)
  }, [tabId, url, activeTab?.isLoading])

  if (!offer.hasForm) return null

  return (
    <button
      type="button"
      onClick={() => {
        void window.browser.invoke('overlay:setState', { visible: true, surface: 'passwords' })
      }}
      aria-label={
        offer.count > 0
          ? `Fill a saved sign-in (${offer.count} saved for this site)`
          : 'Saved sign-ins'
      }
      title={offer.count > 0 ? `${offer.count} saved for this site` : 'Nothing saved for this site'}
      className={`flex cursor-default items-center gap-1 rounded-lg px-1.5 py-1 transition hover:bg-white/10 ${
        offer.count > 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
      }`}
    >
      <Icon name="lock" size={14} />
      {offer.count > 0 && <span className="font-mono text-[10px]">{offer.count}</span>}
    </button>
  )
}
