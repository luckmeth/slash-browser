import { useEffect, useState } from 'react'
import type { CleanupStatus } from '@shared/types/cleanup'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * CLEAN THIS PAGE — the toolbar button.
 *
 * Only the button lives here. The panel it opens is `CleanupPanel`, rendered in
 * the **overlay view**: as a dropdown in this document it was composited under
 * the native page view, so the part extending over the page was never drawn and
 * it looked cut off by the window. The shield panel had the identical bug.
 */
export function CleanButton(): React.JSX.Element | null {
  const [status, setStatus] = useState<CleanupStatus | null>(null)
  const activeTab = useBrowserStore((s) => s.activeTab())

  // Re-read when the page changes: a new document is never still cleaned.
  useEffect(() => {
    void window.browser.invoke('cleanup:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }, [activeTab?.url])

  if (!status || status.host === '') return null

  return (
    <button
      type="button"
      aria-label="Clean this page"
      title={status.active ? 'This page has been cleaned' : 'Clean this page'}
      onClick={() => {
        void window.browser.invoke('overlay:setState', { visible: true, surface: 'cleanup' })
      }}
      className="cursor-default rounded p-1 transition hover:bg-white/10"
    >
      <Icon
        name="sparkle"
        size={14}
        className={status.active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}
      />
    </button>
  )
}
