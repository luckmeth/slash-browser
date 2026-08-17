import { useEffect, useState } from 'react'
import type { BlockingStatus } from '@shared/types/blocking'
import { isInternalUrl } from '@shared/types/tab'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * The shield button: how many requests were blocked on this page.
 *
 * Only the button lives here. The panel it opens is `ShieldPanel`, rendered in
 * the **overlay view** — this document is the chrome, and the native page view
 * composites above it, so a dropdown drawn here was invisible wherever it
 * overlapped the page. That was a shipped bug, not a hypothetical: the panel
 * showed only as a sliver over the settings side panel.
 */
export function ShieldButton(): React.JSX.Element | null {
  const activeTab = useBrowserStore((s) => s.activeTab())
  const [status, setStatus] = useState<BlockingStatus | null>(null)

  const tabId = activeTab?.id ?? null
  const url = activeTab?.url ?? ''

  useEffect(() => {
    if (!tabId || isInternalUrl(url)) {
      setStatus(null)
      return
    }
    const load = (): void => {
      void window.browser.invoke('blocking:status', { tabId }).then((result) => {
        if (result.ok) setStatus(result.value)
      })
    }
    load()
    // Counts climb as sub-resources load, so poll briefly while the page settles
    // rather than showing a number that is stale the moment it appears.
    const timer = setInterval(load, 1200)
    return () => clearInterval(timer)
  }, [tabId, url, activeTab?.isLoading])

  if (!status || isInternalUrl(url)) return null

  const off = status.siteAllowed || !status.adsEnabled
  const count = status.blockedOnPage

  return (
    <button
      type="button"
      onClick={() => {
        void window.browser.invoke('overlay:setState', { visible: true, surface: 'shield' })
      }}
      aria-label={`Content blocking — ${count} requests blocked on this page`}
      title={`${count} blocked on this page`}
      className={`flex cursor-default items-center gap-1 rounded-lg px-1.5 py-1 transition hover:bg-white/10 ${
        off ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-good)]'
      }`}
    >
      <Icon name={off ? 'shieldOff' : 'shield'} size={14} />
      {!off && count > 0 && <span className="font-mono text-[10px]">{count}</span>}
    </button>
  )
}
