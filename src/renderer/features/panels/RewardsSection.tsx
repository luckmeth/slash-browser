import { useEffect, useState } from 'react'
import type { RewardsStatus } from '@shared/types/rewards'
import { COIN_DISCLAIMER } from '@shared/types/rewards'
import { REWARDS_URL } from '@shared/types/tab'
import { Toggle } from './SettingsControls'

/**
 * Slash Coin, in Settings.
 *
 * Deliberately short: this is the switch and a way through to the page, not a
 * second copy of it. The one thing stated here in full is what turning it on
 * actually sends, because that is the sentence somebody needs *before* the
 * decision rather than after it.
 *
 * Unlike sponsored placements, this genuinely is optional and the switch stays
 * — it is the only feature in the browser that reports anything about when a
 * person was at their machine, so principle 2 requires it be opt-in and
 * reversible.
 */
export function RewardsSection(): React.JSX.Element {
  const [status, setStatus] = useState<RewardsStatus | null>(null)

  useEffect(() => {
    void window.browser.invoke('rewards:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    return window.browser.on('rewards:changed', (next) => setStatus(next))
  }, [])

  return (
    <div>
      <Toggle
        label="Collect Slash Coin while browsing"
        hint={
          'Reports how long you browse — closed stretches of time, and nothing else. Never which pages, never what is on them, and never anything from a private window. Off until you turn it on, and it earns nothing until you sign in.'
        }
        checked={status?.enabled ?? false}
        onChange={(value) => {
          void window.browser
            .invoke('settings:update', { rewardsEnabled: value })
            .then(() => window.browser.invoke('rewards:status', undefined))
            .then((result) => {
              if (result.ok) setStatus(result.value)
            })
        }}
      />

      {status?.enabled === true && (
        <div className="px-3.5 pb-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void window.browser.invoke('tabs:create', {
                  url: REWARDS_URL,
                  background: false
                })
              }
              className="cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10"
            >
              Open Slash Coin
            </button>
            {status.signedIn ? (
              <span className="text-[11px] text-[var(--color-text-muted)]">
                Signed in as {status.email} ·{' '}
                {status.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} coins
              </span>
            ) : (
              <span className="text-[11px] text-[var(--color-text-muted)]">
                Not signed in, so nothing is being collected or sent.
              </span>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {COIN_DISCLAIMER}
          </p>
        </div>
      )}
    </div>
  )
}
