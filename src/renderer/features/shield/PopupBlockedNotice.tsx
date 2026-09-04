
import type { PopupBlocked } from '@shared/types/blocking'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

export const POPUP_NOTICE_HEIGHT = 44

/**
 * Shown when Slash Shield stops a window the page opened by itself.
 *
 * This notice is not decoration — it is the half of popup blocking that makes a
 * wrong call survivable. A blocker that guesses wrong and says nothing is
 * indistinguishable from a broken link, and the user has no way to tell which
 * happened or to get the page they wanted. So every block is held with its URL
 * and offered here.
 *
 * A chrome row rather than a floating banner, for the same reason as the handoff
 * notice: anything drawn in this document sits *underneath* the native page
 * view, so it has to take real layout space and inset the page.
 */
export function PopupBlockedNotice({
  blocked,
  onDismiss
}: {
  blocked: PopupBlocked | null
  onDismiss: () => void
}): React.JSX.Element | null {
  const activeTab = useBrowserStore((s) => s.activeTab())

  if (!blocked || !activeTab) return null

  const dismiss = onDismiss

  return (
    <div
      style={{ height: POPUP_NOTICE_HEIGHT }}
      className="glass glass-divide-b flex shrink-0 items-center gap-3 px-3"
      role="status"
    >
      <Icon name="shield" size={14} className="shrink-0 text-[var(--color-accent)]" />
      <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
        <span className="text-[var(--color-text-primary)]">
          Slash Shield blocked a popup from {blocked.popup.pageHost}
        </span>
        {' — '}
        {blocked.explanation}
      </p>

      <button
        type="button"
        title={blocked.popup.url}
        onClick={() => {
          // Sends the id of something already held, never a URL — main looks the
          // address up in its own record.
          void window.browser.invoke('shield:releasePopup', {
            id: blocked.popup.id,
            tabId: activeTab.id
          })
          dismiss()
        }}
        className="shrink-0 cursor-default rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-[var(--color-text-primary)] transition hover:bg-white/15"
      >
        Show it
      </button>

      <button
        type="button"
        onClick={() => {
          void window.browser.invoke('shield:allowPopupsHere', { tabId: activeTab.id })
          dismiss()
        }}
        className="shrink-0 cursor-default rounded-lg px-2.5 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)]"
      >
        Always allow this site
      </button>

      <button
        type="button"
        aria-label="Keep blocked"
        onClick={dismiss}
        className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
