import { useEffect, useState } from 'react'
import type { RewardsStatus } from '@shared/types/rewards'
import type { RemoteConfig } from '@shared/types/remoteConfig'
import { ADVERTISE_URL, REWARDS_URL } from '@shared/types/tab'
import { Icon } from '../../components/Icon'
import { SlashCoin } from '../../components/SlashCoin'
import { lowestRate } from './rateCard'

/**
 * The two things Slash says about itself on the start page: collect coins, and
 * buy a placement.
 *
 * **Why these were rebuilt.** They used to be two stacked full-width rows
 * sharing one skeleton with every other list item on the page — a 40px icon
 * square, a 14px title, a 12px muted subtitle. Identical, in other words, to a
 * closed-tab entry, and between them taller than the paid tile above. The two
 * surfaces meant to *sell* looked exactly like the ones meant to be skimmed
 * past.
 *
 * **The rule they are built under, which matters more than the design.** The
 * sponsored placements above are the income. These two must be better without
 * being *louder*, so:
 *
 *  - they sit below every paid placement, in DOM order and reading order;
 *  - they are half-column width in a two-up grid, never full width;
 *  - their headline is smaller than a sponsored headline, and they carry no
 *    bitmap at all;
 *  - one muted **From Slash** heading covers both, so a reader can still tell an
 *    advert somebody paid for from the browser talking about itself.
 *
 * There is deliberately no solid accent button here. A filled call to action
 * sitting under a sponsored tile competes with it, and the paid surface has to
 * win that comparison — the prominent **Book a run** button lives on the
 * advertise page, where nothing is being sold around it.
 *
 * Both halves keep their own gate, so this renders two cards, one, or nothing.
 * The parent owns both data reads precisely so it can pick the column count: two
 * independent children each returning `null` would leave a lone half-width card
 * floating against dead space.
 */
export function PitchCards(): React.JSX.Element | null {
  const [status, setStatus] = useState<RewardsStatus | null>(null)
  const [config, setConfig] = useState<RemoteConfig | null>(null)

  useEffect(() => {
    void window.browser.invoke('rewards:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    return window.browser.on('rewards:changed', (next) => setStatus(next))
  }, [])

  useEffect(() => {
    void window.browser.invoke('config:remote', undefined).then((result) => {
      if (result.ok) setConfig(result.value)
    })
    return window.browser.on('config:changed', (next) => setConfig(next))
  }, [])

  // The publisher's remote switch. Defaults to shown, so the card is there from
  // the first paint rather than appearing a moment later once the config lands.
  const advertiseAllowed = config?.showAdvertiseCta ?? true
  const showCoin = status !== null
  const count = (showCoin ? 1 : 0) + (advertiseAllowed ? 1 : 0)
  if (count === 0) return null

  return (
    <section className="animate-rise mt-10 w-full">
      <h2 className="mb-3 text-[11px] font-medium tracking-[0.12em] text-[var(--color-text-muted)] uppercase">
        From Slash
      </h2>
      <div className={`grid gap-2.5 ${count === 2 ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
        {showCoin && <CoinPitch status={status} />}
        {advertiseAllowed && <AdvertisePitch config={config} />}
      </div>
    </section>
  )
}

/**
 * The shared shell.
 *
 * `glass-raised` and `slash-lift` rather than a bespoke `backdrop-filter`:
 * `:root[data-effects='reduced']` only catches `.glass*` and Tailwind's
 * `backdrop-blur*` classes, so a hand-rolled filter would survive that switch
 * and go on costing a low-end machine the frames it was turned off to save.
 */
function PitchCard({
  onClick,
  mark,
  children
}: {
  onClick: () => void
  /** The badge in the corner. A node, so the Coin card can show a real coin. */
  mark: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-raised slash-lift group relative flex cursor-default flex-col items-start gap-2.5 overflow-hidden rounded-2xl border border-[var(--glass-edge)] p-4 text-left transition hover:border-[var(--color-accent)]"
    >
      {/* A lit top edge. Enough to make the pair read as one considered tier,
          without a border strong enough to compete with the paid surfaces. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent)]/50 to-transparent"
      />
      <span className="flex w-full items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
          {mark}
        </span>
        <Icon
          name="forward"
          size={13}
          className="ml-auto shrink-0 text-[var(--color-text-muted)] transition group-hover:text-[var(--color-accent)]"
        />
      </span>
      {children}
    </button>
  )
}

/**
 * Slash Coin.
 *
 * Three states, and the copy for each is unchanged. Before opting in and before
 * signing in this is an invitation rather than a counter — there is no balance
 * to state and it must not imply one.
 *
 * The balance shown is always the server's last word. `docs/SLASH-COIN.md` is
 * built around that: a balance the client computes is a balance a text editor
 * can forge.
 */
function CoinPitch({ status }: { status: RewardsStatus }): React.JSX.Element {
  const open = (): void =>
    void window.browser.invoke('tabs:create', { url: REWARDS_URL, background: false })

  if (!status.enabled || !status.signedIn) {
    return (
      <PitchCard onClick={open} mark={<SlashCoin size={18} />}>
        <span className="block text-[13px] font-semibold">
          {status.enabled ? 'Sign in to collect Slash Coin' : 'Earn Slash Coin while you browse'}
        </span>
        <span className="block text-[11.5px] leading-snug text-[var(--color-text-muted)]">
          {status.enabled
            ? 'Your browsing time is not being collected until you sign in.'
            : 'Collect coins for the time you spend browsing. Points only, with no cash value.'}
        </span>
      </PitchCard>
    )
  }

  // Today against the daily cap — the one genuinely persuasive element here,
  // and it is free: a real number that moves. Hidden when the server reports no
  // cap rather than dividing by zero.
  const cap = status.dailyCapSeconds
  const progress = cap > 0 ? Math.min(1, status.secondsToday / cap) : null

  return (
    <PitchCard onClick={open} mark={<SlashCoin size={18} />}>
      <span className="block text-[10px] tracking-[0.12em] text-[var(--color-text-muted)] uppercase">
        Slash Coin
      </span>
      <span className="slash-gradient-text block text-[26px] leading-none font-semibold tabular-nums">
        {status.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>

      {progress !== null && (
        <span
          aria-hidden="true"
          className="block h-0.5 w-full overflow-hidden rounded-full bg-white/10"
        >
          <span
            className="block h-full rounded-full bg-[var(--color-accent)]"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </span>
      )}

      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${
            status.earning ? 'slash-ad-pulse bg-[var(--color-accent)]' : 'bg-white/25'
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">
          {status.note}
        </span>
      </span>
    </PitchCard>
  )
}

/**
 * The top of the revenue funnel.
 *
 * The only place a company that has never heard of the advertising product will
 * encounter it. The "from $X" line is derived from the served rate card by
 * `lowestRate`, never held as a second number, so an operator editing the rates
 * changes the headline and the table at once or neither — and it is omitted
 * entirely rather than guessed at when no rate card has arrived.
 *
 * The three chips are the only claims the advertise page can actually stand
 * behind. There is no audience figure, here or anywhere: impression counts
 * arrive aggregated, hours late, and only from browsers that were reopened.
 */
function AdvertisePitch({ config }: { config: RemoteConfig | null }): React.JSX.Element {
  const placements = config?.advertising.placements ?? []
  const from = placements.length > 0 ? lowestRate(placements) : null

  return (
    <PitchCard
      onClick={() =>
        void window.browser.invoke('tabs:create', { url: ADVERTISE_URL, background: false })
      }
      mark={<Icon name="sparkle" size={14} />}
    >
      <span className="block text-[13px] font-semibold">Advertise on Slash</span>
      <span className="block text-[11.5px] leading-snug text-[var(--color-text-muted)]">
        Book the start page by the hour
        {from !== null ? `, from $${from}` : ''}. One advertiser at a time.
      </span>
      <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
        {['By the hour', 'No targeting', 'Human review'].map((chip) => (
          <span
            key={chip}
            className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
          >
            {chip}
          </span>
        ))}
      </span>
    </PitchCard>
  )
}
