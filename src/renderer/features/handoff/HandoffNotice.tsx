import { handoffHintFor } from '@shared/externalHandoff'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

export const HANDOFF_NOTICE_HEIGHT = 44

/**
 * Shown on sites known to refuse browsers they do not recognise.
 *
 * The alternative would have been to make Slash claim to be Google Chrome so the
 * check passes. That is deliberately not what this does: the browser says what
 * is happening and offers a way through rather than lying about what it is.
 *
 * A chrome row rather than a floating banner, for the same reason as the find
 * bar — anything drawn in this document sits *underneath* the native page view,
 * so it has to take real layout space and inset the page.
 */
export function HandoffNotice(): React.JSX.Element | null {
  const activeTab = useBrowserStore((s) => s.activeTab())
  const dismissedFor = useBrowserStore((s) => s.handoffDismissedHost)
  const dismissHandoff = useBrowserStore((s) => s.dismissHandoff)

  const hint = handoffHintFor(activeTab?.url ?? '')

  if (!hint || !activeTab || dismissedFor === hint.host) return null

  return (
    <div
      style={{ height: HANDOFF_NOTICE_HEIGHT }}
      className="glass glass-divide-b flex shrink-0 items-center gap-3 px-3"
      role="status"
    >
      <Icon name="warning" size={14} className="shrink-0 text-amber-400" />
      <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]" title={hint.reason}>
        {hint.reason}
      </p>

      <button
        type="button"
        onClick={() => {
          void window.browser.invoke('shell:openTabExternally', { tabId: activeTab.id })
        }}
        className="flex shrink-0 cursor-default items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-black transition hover:opacity-90"
      >
        <Icon name="external" size={12} />
        Open in default browser
      </button>

      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismissHandoff(hint.host)}
        className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
