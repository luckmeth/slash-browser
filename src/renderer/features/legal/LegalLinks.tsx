import { PRIVACY_URL, TERMS_URL } from '@shared/types/tab'

/**
 * The two documents, where the decision is being made.
 *
 * Put at the foot of Slash Coin and of the advertising page rather than only
 * in Settings, because that is where somebody is deciding whether to hand over
 * a date of birth, a wallet address or a card. A link in a menu three screens
 * away is a link nobody reads, and "they could have found it" is not the same
 * as telling them.
 */
export function LegalLinks({ context }: { context: 'coin' | 'advertising' }): React.JSX.Element {
  const open = (url: string): void => {
    void window.browser.invoke('tabs:create', { url, background: false })
  }

  return (
    <p className="mt-6 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
      {context === 'coin'
        ? 'Collecting is opt-in, coins are points with no cash value, and your details are readable by nobody but you and Slash. '
        : 'Every campaign is reviewed by a person, you are not charged until it is approved, and nothing about readers is collected. '}
      <button
        type="button"
        onClick={() => open(TERMS_URL)}
        className="cursor-default text-[var(--color-accent)] underline underline-offset-2"
      >
        Terms of use
      </button>
      {' · '}
      <button
        type="button"
        onClick={() => open(PRIVACY_URL)}
        className="cursor-default text-[var(--color-accent)] underline underline-offset-2"
      >
        Privacy
      </button>
    </p>
  )
}
