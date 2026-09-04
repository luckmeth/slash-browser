import type { NavigationNotice } from '@shared/types/blocking'
import { Icon } from '../../components/Icon'

export const NAV_NOTICE_HEIGHT = 44

/**
 * Shown when Slash Shield refused a top-level navigation.
 *
 * Before this existed, a refused malicious navigation cancelled the request and
 * told the user nothing — a failed page load, indistinguishable from the site
 * being down. A browser that silently refuses to go somewhere is worse than one
 * that explains why.
 *
 * The wording never asserts a site is malicious unless a rule said so. A fast
 * redirect chain is a pattern, not evidence, and the copy that reaches the user
 * carries that distinction rather than flattening everything into "dangerous".
 */
export function NavigationBlockedNotice({
  notice,
  onDismiss
}: {
  notice: NavigationNotice | null
  onDismiss: () => void
}): React.JSX.Element | null {
  if (!notice) return null

  return (
    <div
      style={{ height: NAV_NOTICE_HEIGHT }}
      className="glass glass-divide-b flex shrink-0 items-center gap-3 px-3"
      role="status"
    >
      <Icon name="warning" size={14} className="shrink-0 text-amber-400" />
      <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
        <span className="text-[var(--color-text-primary)]">
          Slash Shield stopped this page going to {notice.host}
        </span>
        {' — '}
        {notice.explanation}
      </p>

      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] transition hover:bg-white/10 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
