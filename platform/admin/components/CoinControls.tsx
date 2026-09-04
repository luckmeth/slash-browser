'use client'

import { useActionState, useState } from 'react'
import {
  countdownFrom,
  hourlyValueUsd,
  hoursPerCoin,
  toLocalInput,
  type CoinConfig
} from '@slash/ad-shared'
import { saveCoinConfig, type CoinSaveResult } from '@/app/coin/actions'
import { Field, Group, Measure, Switch } from './Field'

/**
 * The Slash Coin settings, with what the browser will say beside each one.
 *
 * The figures on this screen are the only place they are decided: there is no
 * default in the browser to fall back to, and no second copy in a config file.
 * So the screen shows the *consequence* of each box as it is typed — "6
 * minutes of browsing earns 1 coin", "an hour of browsing is worth $0.50",
 * "counts down 12d 4h 30m" — because `10` and `0.05` in two boxes are
 * unreadable as a policy, and the person setting them is deciding a policy.
 *
 * A client component for exactly that: the preview has to move with the
 * fields. It is still one form posting to a server action, so a browser with
 * JavaScript failing entirely would still save the values, only without the
 * commentary.
 */
export function CoinControls({ config }: { config: CoinConfig }): React.JSX.Element {
  const [state, action, saving] = useActionState<CoinSaveResult, FormData>(
    saveCoinConfig,
    undefined
  )

  const [earningActive, setEarningActive] = useState(config.earningActive)
  const [coinsPerHour, setCoinsPerHour] = useState(String(config.coinsPerHour))
  const [dailyCapHours, setDailyCapHours] = useState(String(config.dailyCapSeconds / 3600))
  const [coinToUsd, setCoinToUsd] = useState(config.coinToUsd === null ? '' : String(config.coinToUsd))
  const [launchAt, setLaunchAt] = useState(toLocalInput(config.launchAt))
  const [maxAgeDays, setMaxAgeDays] = useState(String(config.maxAgeDays))
  const [clockSkewSeconds, setClockSkewSeconds] = useState(String(config.clockSkewSeconds))

  // Read back out of the fields rather than from the saved row, so the preview
  // describes what is about to be saved. NaN is left to the server action to
  // refuse with a sentence; the preview simply has nothing to say.
  const rate = Number(coinsPerHour)
  const value = coinToUsd.trim() === '' ? null : Number(coinToUsd)
  const published = value !== null && Number.isFinite(value) && value > 0
  const launchMs = launchAt.trim() === '' ? null : Date.parse(launchAt)
  const hourly = hourlyValueUsd(rate, published ? value : null)

  return (
    <form action={action}>
      <Group title="Earning">
        <Field
          label="Slash Coin earning"
          why={
            earningActive
              ? 'On. Time spent browsing accrues, and the rewards page shows a live balance.'
              : 'Paused. Nothing accrues for anyone, on any machine — the crediting function refuses every batch while this is off, so it is not a label. The rewards page says so in as many words. Coins already collected are untouched, and time spent during a pause is not banked and paid out later.'
          }
        >
          {/* The name is what the action reads; an unchecked box sends nothing,
              which is exactly how "off" reaches the server. */}
          <Switch
            name="earningActive"
            checked={earningActive}
            onChange={setEarningActive}
            on="Active"
            off="Paused"
          />
        </Field>

        <Field
          label="Earning rate"
          htmlFor="coinsPerHour"
          why="Coins credited per hour of qualifying browsing. Qualifying means Slash is the focused window, the machine is not idle, the page is a real one and the daily maximum is not spent."
          after={
            rate > 0 ? (
              <>
                <strong>{hoursPerCoin(rate)}</strong> of browsing earns 1 coin
              </>
            ) : (
              'The browser shows the rate as unpublished at 0.'
            )
          }
        >
          <Measure
            id="coinsPerHour"
            value={coinsPerHour}
            onChange={setCoinsPerHour}
            unit="coins / hour"
            step="0.0001"
            min="0"
          />
        </Field>

        <Field
          label="Daily maximum"
          htmlFor="dailyCapHours"
          why="The most one account can earn for in a UTC day, across every machine it is signed in on. Reached, the browser says so and stops counting until midnight UTC."
          after={
            rate > 0 && Number(dailyCapHours) > 0 ? (
              <>
                up to <strong>{(rate * Number(dailyCapHours)).toLocaleString()} coins</strong> a day
              </>
            ) : null
          }
        >
          <Measure
            id="dailyCapHours"
            value={dailyCapHours}
            onChange={setDailyCapHours}
            unit="hours"
            step="0.5"
            min="0"
            max="24"
          />
        </Field>
      </Group>

      <Group title="Published figures">
        <Field
          label="Coin value"
          htmlFor="coinToUsd"
          wide
          why={
            <>
              What one coin is worth in US dollars, shown on the rewards page as indicative only.
              <strong> Leave it empty to show &ldquo;Pending&rdquo;</strong> — which is the honest
              state until there is a figure, and is not the same as zero. Zero would tell people
              their coins are worth nothing.
            </>
          }
          after={
            published ? (
              <>
                shown as <strong>${value.toFixed(4)} / coin</strong>
                {hourly !== null && (
                  <>
                    <br />
                    an hour of browsing ≈ <strong>${hourly.toFixed(4)}</strong>
                  </>
                )}
              </>
            ) : (
              <>
                shown as <strong>Pending</strong>
              </>
            )
          }
        >
          <Measure
            id="coinToUsd"
            value={coinToUsd}
            onChange={setCoinToUsd}
            lead="$"
            unit="/ coin"
            step="0.00000001"
            min="0"
            placeholder="empty — Pending"
          />
        </Field>

        <Field
          label="Launch"
          htmlFor="launchAt"
          wide
          why="The end of the pre-launch period. The rewards page counts down to it in days, hours, minutes and seconds. Empty means no countdown is shown at all, and the campaign end date is used as a fallback."
          after={
            launchMs === null || !Number.isFinite(launchMs) ? (
              'no countdown shown'
            ) : countdownFrom(launchMs, Date.now()) === null ? (
              'that moment has passed — no countdown shown'
            ) : (
              <>
                counts down <strong>{countdownFrom(launchMs, Date.now())}</strong>
              </>
            )
          }
        >
          {/* Local time, because an operator setting a launch date is thinking
              in their own clock. The action converts to UTC on the way in. */}
          <input
            id="launchAt"
            type="datetime-local"
            name="launchAt"
            value={launchAt}
            onChange={(event) => setLaunchAt(event.target.value)}
          />
        </Field>
      </Group>

      {/* The two figures nobody changes twice a year. Collapsed rather than
          hidden: they are fraud controls, and the page should not imply the
          browser decides them. */}
      <details className="advanced">
        <summary>Anti-abuse limits — how far back and how far ahead a report may claim</summary>

        <Field
          label="Reporting window"
          htmlFor="maxAgeDays"
          why="How old an interval a browser may still report. Older than this is refused outright: it is either a machine that has been offline for a fortnight, or a replay of a captured batch — and the second matters more than the first."
        >
          <Measure
            id="maxAgeDays"
            value={maxAgeDays}
            onChange={setMaxAgeDays}
            unit="days"
            step="1"
            min="1"
            max="90"
          />
        </Field>

        <Field
          label="Clock tolerance"
          htmlFor="clockSkewSeconds"
          why="How far ahead of the server a machine's clock may be before its reports are refused. Some tolerance is honest; a lot of it is a client claiming time that has not happened yet."
        >
          <Measure
            id="clockSkewSeconds"
            value={clockSkewSeconds}
            onChange={setClockSkewSeconds}
            unit="seconds"
            step="10"
            min="0"
            max="3600"
          />
        </Field>
      </details>

      {/* Hidden inputs carry the controlled values: `Measure` renders no name,
          so that the one place a field name is written is here, next to the
          server action that reads it. */}
      <input type="hidden" name="coinsPerHour" value={coinsPerHour} />
      <input type="hidden" name="dailyCapHours" value={dailyCapHours} />
      <input type="hidden" name="coinToUsd" value={coinToUsd} />
      <input type="hidden" name="maxAgeDays" value={maxAgeDays} />
      <input type="hidden" name="clockSkewSeconds" value={clockSkewSeconds} />

      <div className="savebar">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {state && 'error' in state && <p className="said bad">{state.error}</p>}
        {state && 'ok' in state && <p className="said good">{state.ok}</p>}
        {!state && (
          <p className="said">
            Browsers read this on their next check, not instantly.
          </p>
        )}
      </div>
    </form>
  )
}

/**
 * The rewards page, as these settings will render it.
 *
 * Deliberately not a screenshot and not a live embed: it is the four figures
 * this screen controls, in the wording the browser uses for them. The point is
 * that "Pending" is a *visible outcome* of leaving a box empty, rather than
 * something an operator finds out about from a user.
 */
export function CoinPreview({ config }: { config: CoinConfig }): React.JSX.Element {
  const rate = config.coinsPerHour
  const countdown = countdownFrom(config.launchAt, Date.now())

  return (
    <div className="mock">
      <p className="note" style={{ margin: 0 }}>
        <span className={config.earningActive ? 'dot live' : 'dot off'} aria-hidden="true" />
        {config.earningActive ? 'Earning active' : 'Earning is paused for everyone'}
      </p>
      <p className="balance" style={{ marginTop: 10 }}>
        1,240
      </p>
      <p className="note" style={{ marginTop: 4 }}>
        coins{rate > 0 ? ` · ${rate} an hour` : ''} — an example balance
      </p>

      <div className="rows">
        <div className="mrow">
          <span>Earning rate</span>
          <span className={rate > 0 ? undefined : 'pend'}>
            {rate > 0 ? `${hoursPerCoin(rate)} for 1 coin` : 'Pending'}
          </span>
        </div>
        <div className="mrow">
          <span>Coin value</span>
          <span className={config.coinToUsd === null ? 'pend' : undefined}>
            {config.coinToUsd === null ? 'Pending' : `$${config.coinToUsd.toFixed(4)} / coin`}
          </span>
        </div>
        <div className="mrow">
          <span>Daily maximum</span>
          <span>{config.dailyCapSeconds / 3600} hours</span>
        </div>
        <div className="mrow">
          <span>Pre-launch ends in</span>
          <span className={countdown === null ? 'pend' : undefined}>
            {countdown ?? 'no date set'}
          </span>
        </div>
      </div>
    </div>
  )
}
