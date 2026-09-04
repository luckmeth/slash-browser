import { useEffect, useState } from 'react'
import type { RewardsStatus } from '@shared/types/rewards'
import { REWARDS_URL } from '@shared/types/tab'
import { Icon } from '../../components/Icon'

/**
 * The way in to Slash Coin.
 *
 * A capability with no way to reach it is not finished, and a rewards balance
 * buried in Settings is one nobody opens. It lives on the start page beside the
 * advertise card because both are the same kind of thing: an occasional,
 * deliberate destination rather than something that belongs in the chrome.
 *
 * Shows the balance once there is one, and an invitation before that.
 *
 * It deliberately draws *something* in all three states. The first version
 * required the feature to be on **and** signed in, which meant a browser that
 * had never been told about Slash Coin showed no trace of it anywhere: not
 * here, not in the chrome, and not in Settings either, where the group was
 * failing to render for an unrelated reason. Three invisible entry points is
 * how a finished feature becomes one nobody can find.
 */
export function RewardsCard(): React.JSX.Element | null {
  const [status, setStatus] = useState<RewardsStatus | null>(null)

  useEffect(() => {
    void window.browser.invoke('rewards:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    return window.browser.on('rewards:changed', (next) => setStatus(next))
  }, [])

  if (!status) return null

  const open = (): void =>
    void window.browser.invoke('tabs:create', { url: REWARDS_URL, background: false })

  // Before opting in, and before signing in, this is an invitation rather than
  // a counter — there is no balance to state and it must not imply one.
  if (!status.enabled || !status.signedIn) {
    return (
      <button
        type="button"
        onClick={open}
        className="glass-raised animate-rise mt-3 flex w-full cursor-default items-center gap-4 rounded-2xl border border-[var(--glass-edge)] p-4 text-left transition hover:border-[var(--color-accent)]"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
          <Icon name="star" size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium">
            {status.enabled ? 'Sign in to collect Slash Coin' : 'Earn Slash Coin while you browse'}
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-[var(--color-text-muted)]">
            {status.enabled
              ? 'Your browsing time is not being collected until you sign in.'
              : 'Collect coins for the time you spend browsing. Points only, with no cash value.'}
          </span>
        </span>
        <Icon name="forward" size={14} className="shrink-0 text-[var(--color-text-muted)]" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={open}
      className="glass-raised animate-rise mt-3 flex w-full cursor-default items-center gap-4 rounded-2xl border border-[var(--glass-edge)] p-4 text-left transition hover:border-[var(--color-accent)]"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
        <Icon name="star" size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">
          {status.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} Slash Coin
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-[var(--color-text-muted)]">
          {status.note}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${
          status.earning ? 'slash-ad-pulse bg-[var(--color-accent)]' : 'bg-white/25'
        }`}
      />
    </button>
  )
}
