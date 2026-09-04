import { useEffect, useState } from 'react'
import type { RewardsStatus } from '@shared/types/rewards'
import { REWARDS_URL } from '@shared/types/tab'
import { Icon } from '../../components/Icon'

/**
 * The Slash Coin balance, in the workspace row.
 *
 * Lives here rather than in the toolbar because the toolbar row is about *the
 * page you are looking at* — the address, the shield, the reader — while this
 * row is about the browser itself. A balance that changes while you read is
 * exactly the second kind of thing.
 *
 * Three states, and the quiet one matters most:
 *
 *  - **Never switched on:** a quiet "Slash Coin" pill. It counts nothing,
 *    claims nothing and animates nothing — it is a door, not an advert. An
 *    earlier version rendered nothing at all here, which was defensible
 *    reasoning and a bad outcome: with the feature off, the chip, the start
 *    page card and the Settings group were *all* invisible, so the only way in
 *    was a toast ninety seconds after launch that most people never see.
 *  - **On but signed out:** "Sign in to earn". Passive; it does not reappear,
 *    animate or count anything.
 *  - **Signed in:** the balance, with a dot that pulses only while time is
 *    actually accruing. That dot is the honest part: it stops the moment
 *    earning stops, so the chip never implies progress that is not happening.
 *
 * The number is whatever the server last said. Nothing here computes a balance.
 */
export function CoinChip(): React.JSX.Element | null {
  const [status, setStatus] = useState<RewardsStatus | null>(null)

  useEffect(() => {
    void window.browser.invoke('rewards:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    return window.browser.on('rewards:changed', (next) => setStatus(next))
  }, [])

  const open = (): void => {
    void window.browser.invoke('tabs:create', { url: REWARDS_URL, background: false })
  }

  // Until the status arrives there is nothing truthful to draw, and a chip that
  // appears a moment after the window would shift the row under the pointer.
  if (!status) return null

  if (!status.enabled) {
    return (
      <button
        type="button"
        onClick={open}
        title="Slash Coin — earn while you browse"
        className="app-no-drag ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="star" size={13} />
        Slash Coin
      </button>
    )
  }

  if (!status.signedIn) {
    return (
      <button
        type="button"
        onClick={open}
        title="Sign in to collect Slash Coin"
        className="app-no-drag ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition hover:bg-white/5 hover:text-[var(--color-text-primary)]"
      >
        <Icon name="star" size={13} />
        Sign in to earn
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={open}
      title={`${status.note} — open Slash Coin`}
      aria-label={`Slash Coin balance ${formatCoins(status.balance)}. ${status.note}`}
      className="app-no-drag ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1 text-[11.5px] font-medium transition hover:bg-white/12"
    >
      <Icon name="star" size={13} className="text-[var(--color-accent)]" />
      <span className="tabular-nums">{formatCoins(status.balance)}</span>
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${
          status.earning ? 'slash-ad-pulse bg-[var(--color-accent)]' : 'bg-white/25'
        }`}
      />
    </button>
  )
}

/**
 * Compact enough for a chrome row.
 *
 * Thousands become "1.2k" because the row has a fixed height and a growing
 * number would push the workspace tabs sideways as somebody earned — a layout
 * that shifts on its own is worse than a rounded figure, and the exact balance
 * is one click away on the page itself.
 */
function formatCoins(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 100 ? 1 : 0 })
}
