import { Icon } from '../../components/Icon'

export const PRIVATE_NOTICE_HEIGHT = 40

/**
 * The standing marker on a private window.
 *
 * Permanent rather than dismissible, and stating the limit as prominently as the
 * promise. Every browser's private mode gets misread as anonymity, and the
 * misreading is the browser's fault when the UI only advertises what it hides.
 * What this actually does is keep the session off this device; it does nothing
 * about what your network, your employer, or the sites you visit can see.
 */
export function PrivateNotice(): React.JSX.Element {
  return (
    <div
      style={{ height: PRIVATE_NOTICE_HEIGHT }}
      className="glass glass-divide-b flex shrink-0 items-center gap-2.5 px-3"
      role="status"
    >
      <Icon name="eye" size={13} className="shrink-0 text-[var(--color-accent)]" />
      <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text-primary)]">Private window</span>
        {' — nothing is saved to this device: no history, no browsing memory, no restore points. '}
        <span className="opacity-80">
          Your network, your employer and the sites you visit can still see this activity.
        </span>
      </p>
    </div>
  )
}
