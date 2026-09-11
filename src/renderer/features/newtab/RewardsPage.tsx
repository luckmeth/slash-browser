import { useEffect, useState } from 'react'
import { SlashCoin } from '../../components/SlashCoin'
import type { RewardsStatus } from '@shared/types/rewards'
import { COIN_DISCLAIMER } from '@shared/types/rewards'
import { Icon } from '../../components/Icon'
import { useReveal } from '../../hooks/useReveal'
import { ProfileCard } from '../rewards/ProfileCard'
import { hoursPerCoin } from './coinRates'
import { LegalLinks } from '../legal/LegalLinks'

/**
 * Slash Coin, for somebody who has never heard of it.
 *
 * This page has to do a job no other screen in the browser does: explain an
 * offer well enough that a stranger opts in. So it is built like a landing
 * page — hero, proof, mechanism, objection handling, call to action — rather
 * than like a settings pane.
 *
 * Three rules it does not break to get there:
 *
 * **No cash language, anywhere.** No currency symbol, no conversion rate, no
 * "worth". Granting future value for present activity is the structure
 * regulators look at hardest, and the wording here is what would be quoted
 * back. `COIN_DISCLAIMER` is the one place that sentence lives.
 *
 * **No number before opt-in.** The rate and the daily maximum come from the
 * server, and fetching them before somebody has switched the feature on would
 * be a request to our own service from a browser whose owner has not agreed to
 * talk to it — exactly the phone-home principle 2 rules out. So the hero sells
 * the mechanism, and the figures appear the moment it is on.
 *
 * **The honest state is as prominent as the number.** `note` says why nothing
 * is accruing. A balance that silently stops moving is the least answerable
 * complaint a scheme like this can generate.
 */
export function RewardsPage(): React.JSX.Element {
  const [status, setStatus] = useState<RewardsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [pasted, setPasted] = useState('')
  const [pasteNote, setPasteNote] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const page = useReveal<HTMLDivElement>()

  const load = (): void => {
    void window.browser.invoke('rewards:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(() => {
    load()
    return window.browser.on('rewards:changed', (next) => setStatus(next))
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const enabled = status?.enabled ?? false
  const signedIn = status?.signedIn ?? false

  const setEnabled = (value: boolean): void => {
    void window.browser.invoke('settings:update', { rewardsEnabled: value }).then(load)
  }

  const signIn = (): void => {
    setBusy(true)
    setProblem('')
    void window.browser.invoke('rewards:signIn', undefined).then((result) => {
      setBusy(false)
      if (!result.ok) return
      if (!result.value.ok) {
        setProblem(result.value.problem)
        return
      }
      // Opened here in Slash rather than handed to the operating system.
      // Google's sign-in works in this browser — measured — and staying in one
      // browser is what keeps the provider's flow state resolvable.
      if (result.value.url !== '') {
        void window.browser.invoke('tabs:create', { url: result.value.url, background: false })
      }
    })
  }

  // The operator's launch date wins; the campaign end is the fallback for a
  // project that has not set one yet.
  const launchAt = (status?.launchAt ?? 0) > 0 ? status!.launchAt : (status?.campaignEndsAt ?? 0)
  const remaining = Math.max(launchAt - now, 0)
  // Only once the status has arrived: `earningActive` defaults to true, and
  // treating "not loaded yet" as paused would flash a warning on every open.
  const paused = status !== null && !status.earningActive
  // Signed in, but the details a payout needs are missing. The server credits
  // nothing in this state, so the page says so where the balance would be
  // rather than leaving somebody to notice a number that never moves.
  const locked = status !== null && status.signedIn && !status.profileComplete
  const capSeconds = status?.dailyCapSeconds ?? 0
  const todaySeconds = status?.secondsToday ?? 0
  const progress = capSeconds > 0 ? Math.min(todaySeconds / capSeconds, 1) : 0

  return (
    <div ref={page} className="glass-page relative h-full overflow-y-auto">
      {/* Hero ---------------------------------------------------------- */}
      <div className="relative">
        <div className="slash-aurora" aria-hidden="true" />
        <div className="slash-dotgrid" aria-hidden="true" />

        <div className="relative mx-auto flex w-full max-w-3xl flex-col items-center px-8 pt-[9vh] text-center">
          <SlashCoin size={104} />

          {/*
            The badge states the scheme's own state, not an aspiration. While
            an operator has earning switched off, "collecting now" is exactly
            the sentence somebody would quote back — so the pill goes quiet and
            says so, and the pulse stops with it.
          */}
          {locked ? (
            <span className="animate-rise mt-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-warn)]/35 bg-[var(--color-warn)]/10 px-3 py-1 text-[11.5px] font-medium text-[var(--color-warn)]">
              <span className="size-1.5 rounded-full bg-[var(--color-warn)]" />
              One step left — your details
            </span>
          ) : paused ? (
            <span className="animate-rise mt-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-warn)]/35 bg-[var(--color-warn)]/10 px-3 py-1 text-[11.5px] font-medium text-[var(--color-warn)]">
              <span className="size-1.5 rounded-full bg-[var(--color-warn)]" />
              Earning is paused
            </span>
          ) : (
            <span className="animate-rise mt-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-3 py-1 text-[11.5px] font-medium text-[var(--color-accent)]">
              <span className="slash-ad-pulse size-1.5 rounded-full bg-[var(--color-accent)]" />
              Pre-launch — collecting now
            </span>
          )}

          <h1 className="animate-rise slash-gradient-text mt-5 text-[42px] leading-[1.08] font-semibold tracking-tight">
            Get rewarded for time
            <br />
            you already spend.
          </h1>

          <p className="animate-rise mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--color-text-muted)]">
            No adverts to sit through, no surveys, no tasks. Open Slash, browse the way you already
            do, and collect Slash Coin while you are here.
          </p>

          {/* The call to action, in whichever state applies. */}
          <div className="animate-rise mt-7 flex flex-wrap items-center justify-center gap-2.5">
            {!enabled ? (
              <button
                type="button"
                onClick={() => setEnabled(true)}
                className="cursor-default rounded-xl bg-[var(--color-accent)] px-6 py-3 text-[14px] font-semibold text-black shadow-[0_10px_30px_-10px_var(--color-accent)] transition hover:brightness-110"
              >
                Start collecting
              </button>
            ) : !signedIn ? (
              <button
                type="button"
                disabled={busy || status?.available === false}
                onClick={signIn}
                className="cursor-default rounded-xl bg-[var(--color-accent)] px-6 py-3 text-[14px] font-semibold text-black shadow-[0_10px_30px_-10px_var(--color-accent)] transition hover:brightness-110 disabled:opacity-40"
              >
                {busy ? 'Opening…' : 'Sign in with Google'}
              </button>
            ) : (
              <div className="rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-5 py-3 text-[13px] text-[var(--color-accent)]">
                Signed in as {status?.email}
              </div>
            )}
          </div>

          <p className="animate-rise mt-3 text-[11.5px] text-[var(--color-text-muted)]">
            Free · Opt in and out whenever you like · Points only, no cash value
          </p>
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-3xl px-8 pt-12 pb-24">
        {/*
          Stated once, plainly, at the top of the page rather than only as the
          small sentence under the balance. A balance that has quietly stopped
          moving is the least answerable complaint a scheme like this can
          generate, and "we paused it" is a far better answer than silence.
        */}
        {locked && (
          <section className="slash-reveal mb-3 rounded-2xl border border-[var(--color-warn)]/35 bg-[var(--color-warn)]/8 p-4">
            <h2 className="text-[13px] font-semibold text-[var(--color-warn)]">
              Collecting is not switched on yet
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              Slash Coin needs to know who it would be paying before it starts counting: your name,
              date of birth, address, country and phone number, below. It takes a minute and it is
              asked once.
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              Until then <strong>nothing accrues</strong> — and time spent before you fill it in is
              not banked and added afterwards, so there is nothing to be gained by waiting.
            </p>
          </section>
        )}

        {paused && (
          <section className="slash-reveal mb-3 rounded-2xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/8 p-4">
            <h2 className="text-[13px] font-semibold text-[var(--color-warn)]">
              Earning is paused for everyone
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              Slash has switched earning off for the moment, so no time is accruing on any machine
              — this is not something about your account, and nothing you can change here will
              start it. Coins you have already collected are unaffected. Earning resumes the moment
              it is switched back on.
            </p>
          </section>
        )}

        {/*
          The ledger strip.

          An exchange-looking row of figures, and every one of them is real: the
          earning rate the server published, today's counted time against the
          daily cap, and how many closed intervals are still waiting to be sent.
          Nothing here is a price, a change percentage or a chart, because none
          of those exist — `coinToUsd` is nullable and null means *unpublished*,
          not zero. A row of invented numbers is the one thing this page must
          never show, whatever it is styled like.

          Rendered only once somebody has opted in, so the no-number-before-
          opt-in rule holds.
        */}
        {enabled && status && (
          <section className="slash-reveal glass-raised mt-2 grid grid-cols-3 divide-x divide-[var(--glass-edge)] overflow-hidden rounded-2xl">
            <Ledger
              label="Rate"
              value={status.coinsPerHour > 0 ? `${status.coinsPerHour}` : '—'}
              unit="coins an hour"
            />
            <Ledger
              label="Today"
              value={Math.floor(status.secondsToday / 60).toLocaleString()}
              unit={
                status.dailyCapSeconds > 0
                  ? `of ${Math.floor(status.dailyCapSeconds / 60).toLocaleString()} min`
                  : 'minutes'
              }
            />
            <Ledger
              label="Unsent"
              value={String(status.pending)}
              unit={status.pending === 1 ? 'interval' : 'intervals'}
            />
          </section>
        )}

        {/* Balance ------------------------------------------------------ */}
        {enabled && (
          <section className="slash-reveal glass-raised mt-2 overflow-hidden rounded-2xl">
            <div className="relative p-6 text-center">
              <p className="text-[11px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
                Your balance
              </p>
              <p className="slash-gradient-text mt-2 text-[56px] leading-none font-semibold tabular-nums">
                {formatCoins(status?.balance ?? 0)}
              </p>
              <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                coins
                {status && status.coinsPerHour > 0 ? ` · ${status.coinsPerHour} an hour` : ''}
              </p>

              {/* Whether the scheme is running at all, said in as many words:
                  the sentence below it is about this moment on this machine,
                  which is a different question and was the only one answered. */}
              {status && (
                <p className="mt-2 text-[11px] tracking-[0.1em] uppercase">
                  <span className={paused ? 'text-[var(--color-warn)]' : 'text-[var(--color-good)]'}>
                    {paused ? 'Earning inactive' : 'Earning active'}
                  </span>
                </p>
              )}

              <div
                className={`mt-5 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px] ${
                  status?.earning
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'bg-white/8 text-[var(--color-text-muted)]'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${
                    status?.earning ? 'slash-ad-pulse bg-[var(--color-accent)]' : 'bg-white/40'
                  }`}
                />
                {status?.note ?? 'Loading…'}
              </div>
            </div>

            {/* Today, against the cap. */}
            {signedIn && capSeconds > 0 && (
              <div className="border-t border-[var(--glass-edge)] px-6 py-4">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-[12.5px] font-medium">Today</h2>
                  <span className="text-[12px] text-[var(--color-text-muted)] tabular-nums">
                    {formatDuration(todaySeconds)} of {formatDuration(capSeconds)}
                  </span>
                </div>
                <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-700 ${
                      status?.earning ? 'slash-sweep relative overflow-hidden' : ''
                    }`}
                    style={{ width: `${Math.max(progress * 100, 1.5)}%` }}
                  />
                </div>
              </div>
            )}
          </section>
        )}

        {/* Their details, for a payout that has somewhere to go ---------- */}
        {enabled && signedIn && <ProfileCard
            email={status?.email ?? ''}
            locked={locked}
            balance={status?.balance ?? 0}
            coinToUsd={status?.coinToUsd ?? null}
          />}

        {/* Rates -------------------------------------------------------- */}
        {enabled && (
          <section className="slash-reveal mt-3 grid gap-3 sm:grid-cols-2">
            <div className="glass-raised rounded-2xl border border-[var(--glass-edge)] p-4">
              <p className="text-[11px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
                Earning rate
              </p>
              {status && status.coinsPerHour > 0 ? (
                <>
                  <p className="mt-1.5 text-[22px] leading-none font-semibold tabular-nums">
                    {formatCoins(status.coinsPerHour)}{' '}
                    <span className="text-[13px] font-normal text-[var(--color-text-muted)]">
                      coins / hour
                    </span>
                  </p>
                  <p className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">
                    {hoursPerCoin(status.coinsPerHour)} of browsing earns 1 coin.
                  </p>
                </>
              ) : (
                <Pending note="The earning rate has not been published yet." />
              )}
            </div>

            <div className="glass-raised rounded-2xl border border-[var(--glass-edge)] p-4">
              <p className="text-[11px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
                Coin value
              </p>
              {/*
                Null, not zero. Nobody has set a rate yet, and rendering "$0.00"
                would say the coins are worthless rather than that the figure is
                not decided - a different claim, and the wrong one.
              */}
              {status && status.coinToUsd !== null && status.coinToUsd > 0 ? (
                <>
                  <p className="mt-1.5 text-[22px] leading-none font-semibold tabular-nums">
                    ${status.coinToUsd.toFixed(4)}
                    <span className="ml-1 text-[13px] font-normal text-[var(--color-text-muted)]">
                      / coin
                    </span>
                  </p>
                  <p className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">
                    Indicative only. Coins cannot be redeemed or exchanged during pre-launch.
                  </p>
                  {status.balance > 0 && (
                    <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                      Your {formatCoins(status.balance)} coins would be $
                      {(status.balance * status.coinToUsd).toFixed(2)} at that rate.
                    </p>
                  )}
                </>
              ) : (
                <Pending note="No value has been published. It is set by Slash, not by the browser." />
              )}
            </div>
          </section>
        )}

        {/* Countdown ---------------------------------------------------- */}
        {remaining > 0 && (
          <section className="slash-reveal mt-3 overflow-hidden rounded-2xl border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/8 p-5 text-center">
            <p className="text-[11px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
              Pre-launch ends in
            </p>
            <div className="mt-3 flex items-start justify-center gap-2.5">
              {countdownParts(remaining).map(([value, label]) => (
                <div key={label} className="min-w-[62px]">
                  <div className="glass-raised rounded-xl px-2 py-2.5 font-mono text-[24px] leading-none font-semibold tabular-nums">
                    {value}
                  </div>
                  <div className="mt-1.5 text-[10px] tracking-wide text-[var(--color-text-muted)] uppercase">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* How it works ------------------------------------------------- */}
        <section className="slash-reveal mt-14">
          <SectionHeading
            eyebrow="How it works"
            title="Three steps, then nothing to do"
            body="There is no dashboard to check in with and no streak to keep. It runs while you browse and stops when you do."
          />
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              ['star', 'Turn it on', 'One switch. Nothing is collected or sent before you do.'],
              [
                'globe',
                'Sign in with Google',
                'Opens a tab here. You type your password into Google, never into Slash.'
              ],
              [
                'clock',
                'Browse as usual',
                'Time is counted while Slash is the window you are actually using.'
              ]
            ].map(([icon, title, body], index) => (
              <div
                key={title}
                className="glass-raised slash-lift relative rounded-2xl border border-[var(--glass-edge)] p-4"
              >
                <span className="absolute top-3.5 right-4 text-[28px] leading-none font-semibold text-white/[0.06]">
                  {index + 1}
                </span>
                <span className="flex size-9 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
                  <Icon name={icon as 'star'} size={16} />
                </span>
                <h3 className="mt-3 text-[13.5px] font-semibold">{title}</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* What counts -------------------------------------------------- */}
        <section className="slash-reveal mt-14">
          <SectionHeading
            eyebrow="What counts"
            title="Time at the machine, not time switched on"
            body="A computer left running overnight should not out-earn somebody actually reading. These are the rules, in full."
          />
          <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
            {[
              [
                'Slash is the window you are using',
                'Time in the background does not count.'
              ],
              ['You are actually at the machine', 'Two minutes without input pauses it.'],
              ['A real page is open', 'The start page and settings do not earn.'],
              ['Not a private window', 'Nothing about private browsing is reported, ever.'],
              [
                'Under the daily maximum',
                'A cap per day, so a long session cannot run away with it.'
              ],
              [
                'The clock has not jumped',
                'Sleeping the machine banks nothing for the hours it was asleep.'
              ]
            ].map(([title, body]) => (
              <div
                key={title}
                className="glass-raised slash-lift flex gap-3 rounded-xl border border-[var(--glass-edge)] p-3.5"
              >
                <Icon
                  name="sparkle"
                  size={15}
                  className="mt-0.5 shrink-0 text-[var(--color-accent)]"
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{title}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                    {body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Privacy — the actual differentiator --------------------------- */}
        <section className="slash-reveal mt-14 overflow-hidden rounded-2xl border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/[0.07] p-6">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold">
            <Icon name="shield" size={16} className="text-[var(--color-accent)]" />
            What we never see
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Slash reports <strong>how long</strong> you browsed — closed stretches of time, and
            nothing else. Every other rewards scheme of this shape pays for attention data. This one
            cannot, because it never collects any.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {[
              ['Which pages you visit', false],
              ['What is on them', false],
              ['Your searches or history', false],
              ['Anything from a private window', false],
              ['Stretches of time, start and end', true],
              ['A random id for this installation', true]
            ].map(([label, sent]) => (
              <div
                key={String(label)}
                className="flex items-center gap-2.5 rounded-lg bg-black/20 px-3 py-2 text-[12.5px]"
              >
                <span
                  aria-hidden="true"
                  className={`grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                    sent
                      ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                      : 'bg-white/10 text-[var(--color-text-muted)]'
                  }`}
                >
                  {sent ? '↑' : '×'}
                </span>
                <span className={sent ? '' : 'text-[var(--color-text-muted)]'}>
                  {String(label)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] text-[var(--color-text-muted)]">
            The two marked <span className="text-[var(--color-accent)]">↑</span> are the entire
            payload. There is no profile behind it, because there is nothing to build one from.
          </p>
        </section>

        {/* Questions ----------------------------------------------------- */}
        <section className="slash-reveal mt-14">
          <SectionHeading eyebrow="Questions" title="The ones worth asking first" />
          <div className="mt-5 flex flex-col gap-2">
            {[
              [
                'Are these worth money?',
                'No, and nothing here promises they ever will be. Slash Coin is a pre-launch reward with no cash value: it cannot be bought, sold or exchanged. If that ever changes it will be announced properly, with terms, and not implied by a page like this one.'
              ],
              [
                'Does Slash see my Google password?',
                'No. Sign-in opens a tab pointed at Google’s own page, and you type your password into Google exactly as you would anywhere else. Slash receives only a short-lived code that it exchanges for a session, and that session is encrypted with the operating system’s own secure store before it touches the disk.'
              ],
              [
                'Can I earn on several computers?',
                'You can use Slash on as many machines as you like, but overlapping time is only counted once. Two computers signed into one account for the same hour earn that hour, not two.'
              ],
              [
                'What happens if I turn it off?',
                'Counting stops immediately and the stretch you were in the middle of is banked rather than discarded. Your balance stays where it is. Turning it back on resumes.'
              ],
              [
                'Does it slow the browser down?',
                'It checks four things once every thirty seconds and does nothing else. No page is touched, and nothing runs at all until you switch it on.'
              ]
            ].map(([question, answer]) => (
              <details
                key={question}
                className="glass-raised group rounded-xl border border-[var(--glass-edge)] px-4 py-3"
              >
                <summary className="flex cursor-default list-none items-center justify-between gap-3 text-[13.5px] font-medium">
                  {question}
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-[var(--color-text-muted)] transition group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                  {answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* Closing action ------------------------------------------------ */}
        <section className="slash-reveal relative mt-14 overflow-hidden rounded-2xl border border-[var(--glass-edge)] bg-white/[0.04] p-7 text-center">
          <div className="slash-aurora opacity-60" aria-hidden="true" />
          <div className="relative">
            <h2 className="text-[20px] font-semibold">
              {!enabled
                ? 'Start collecting today'
                : !signedIn
                  ? 'One step left'
                  : 'You are all set'}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              {!enabled
                ? 'Switch it on and your browsing time starts counting. Nothing is sent until you sign in, and you can turn it off at any point.'
                : !signedIn
                  ? 'Sign in to attach the time you browse to an account. Until then nothing is collected and nothing is sent.'
                  : 'Slash Coin is collecting while you browse. Nothing else to do.'}
            </p>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {!enabled ? (
                <button
                  type="button"
                  onClick={() => setEnabled(true)}
                  className="cursor-default rounded-xl bg-[var(--color-accent)] px-6 py-2.5 text-[13.5px] font-semibold text-black transition hover:brightness-110"
                >
                  Start collecting
                </button>
              ) : !signedIn ? (
                <>
                  <button
                    type="button"
                    disabled={busy || status?.available === false}
                    onClick={signIn}
                    className="cursor-default rounded-xl bg-[var(--color-accent)] px-6 py-2.5 text-[13.5px] font-semibold text-black transition hover:brightness-110 disabled:opacity-40"
                  >
                    {busy ? 'Opening…' : 'Sign in with Google'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEnabled(false)}
                    className="cursor-default rounded-xl border border-[var(--color-border-subtle)] px-5 py-2.5 text-[13.5px] transition hover:border-[var(--color-accent)]"
                  >
                    Turn off
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true)
                      void window.browser.invoke('rewards:refresh', undefined).then((result) => {
                        setBusy(false)
                        if (result.ok) setStatus(result.value)
                      })
                    }}
                    className="cursor-default rounded-xl border border-[var(--color-border-subtle)] px-5 py-2.5 text-[13.5px] transition hover:border-[var(--color-accent)] disabled:opacity-40"
                  >
                    {busy ? 'Syncing…' : 'Sync now'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void window.browser.invoke('rewards:signOut', undefined).then((result) => {
                        if (result.ok) setStatus(result.value)
                      })
                    }}
                    className="cursor-default rounded-xl border border-[var(--color-border-subtle)] px-5 py-2.5 text-[13.5px] transition hover:border-[var(--color-accent)]"
                  >
                    Sign out
                  </button>
                </>
              )}
            </div>

            {/*
              The manual finish, shown *while the sign-in is waiting* rather
              than hidden behind a disclosure. The redirect at the end of an
              OAuth flow is the one step this browser does not control, and when
              it goes astray the code is sitting in the address of whatever page
              the browser landed on. Asking for that address is a working path
              on a day when the redirect is not.
            */}
            {enabled && !signedIn && status?.awaitingCode === true && (
              <div className="mx-auto mt-5 max-w-md rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/8 p-4 text-left">
                <p className="text-[13px] font-medium">Waiting for Google…</p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                  Finish signing in on the tab that opened. If you end up on an error page instead
                  — anything saying the site refused the connection — copy that page&rsquo;s whole
                  address and paste it here. The code is in it.
                </p>
                <div className="mt-2.5 flex gap-2">
                  <input
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                    placeholder="http://localhost:3000/?code=…"
                    aria-label="Address you landed on"
                    className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--color-accent)]"
                  />
                  <button
                    type="button"
                    disabled={pasted.trim() === ''}
                    onClick={() => {
                      setPasteNote('')
                      void window.browser
                        .invoke('rewards:completeSignIn', { pasted })
                        .then((result) => {
                          if (!result.ok) return
                          if (result.value.ok) {
                            setPasted('')
                            setPasteNote('')
                          } else {
                            setPasteNote(result.value.problem)
                          }
                        })
                    }}
                    className="shrink-0 cursor-default rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-black transition hover:brightness-110 disabled:opacity-40"
                  >
                    Finish
                  </button>
                </div>
                {pasteNote !== '' && (
                  <p className="mt-2 text-[12px] text-[var(--color-warn)]">{pasteNote}</p>
                )}
              </div>
            )}

            {status?.available === false && (
              <p className="mt-3 text-[12px] text-[var(--color-warn)]">
                This machine has no secure store, so Slash will not keep a sign-in here.
              </p>
            )}
            {problem !== '' && <p className="mt-3 text-[12px] text-[var(--color-warn)]">{problem}</p>}
            {signedIn && status && status.pending > 0 && (
              <p className="mt-3 text-[11.5px] text-[var(--color-text-muted)]">
                {status.pending} stretch{status.pending === 1 ? '' : 'es'} of browsing waiting to be
                sent.
              </p>
            )}
          </div>
        </section>

        <p className="slash-reveal mt-6 rounded-xl border border-[var(--glass-edge)] bg-white/[0.03] p-4 text-center text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          {COIN_DISCLAIMER}
        </p>
            <LegalLinks context="coin" />
      </div>
    </div>
  )
}

/**
 * One figure in the ledger strip.
 *
 * `tabular-nums` throughout: these update while the page is open, and digits
 * that change width make a row of numbers twitch.
 */
function Ledger({
  label,
  value,
  unit
}: {
  label: string
  value: string
  unit: string
}): React.JSX.Element {
  return (
    <div className="px-4 py-3.5 text-center">
      <p className="text-[10px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
        {label}
      </p>
      <p className="mt-1 text-[20px] leading-none font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-[10.5px] text-[var(--color-text-muted)]">{unit}</p>
    </div>
  )
}

function SectionHeading({
  eyebrow,
  title,
  body
}: {
  eyebrow: string
  title: string
  body?: string
}): React.JSX.Element {
  return (
    <div className="text-center">
      <span className="text-[11px] font-medium tracking-[0.14em] text-[var(--color-accent)] uppercase">
        {eyebrow}
      </span>
      <h2 className="mt-2 text-[24px] leading-tight font-semibold tracking-tight">{title}</h2>
      {body !== undefined && (
        <p className="mx-auto mt-2.5 max-w-xl text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          {body}
        </p>
      )}
    </div>
  )
}

/**
 * A figure nobody has published yet.
 *
 * Its own component so every unset rate reads the same way, and so "Pending" is
 * visibly a *state* rather than a number that happens to be missing.
 */
function Pending({ note }: { note: string }): React.JSX.Element {
  return (
    <>
      <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-white/[0.07] px-2 py-1 text-[13px] font-medium text-[var(--color-text-muted)]">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--color-warn)]" />
        Pending
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">{note}</p>
    </>
  )
}

function formatCoins(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

/** Split for the boxed countdown, so each unit can sit in its own tile. */
function countdownParts(ms: number): [string, string][] {
  const total = Math.floor(ms / 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return [
    [String(Math.floor(total / 86400)), 'days'],
    [pad(Math.floor((total % 86400) / 3600)), 'hours'],
    [pad(Math.floor((total % 3600) / 60)), 'mins'],
    [pad(total % 60), 'secs']
  ]
}
