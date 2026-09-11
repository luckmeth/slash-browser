import { useEffect, useRef, useState } from 'react'
import type { RemoteConfig } from '@shared/types/remoteConfig'
import { DEFAULT_REMOTE_CONFIG } from '@shared/types/remoteConfig'
import { PlacementPreview } from './PlacementPreview'
import { originOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'
import { useReveal } from '../../hooks/useReveal'
import { lowestRate } from './rateCard'
import { CampaignComposer } from '../advertise/CampaignComposer'

/**
 * What advertising on Slash is, what it costs, and how to book it.
 *
 * The top of the revenue funnel, and the page a company lands on after pressing
 * the card on the start page. Built like a landing page, because the reader is
 * deciding whether to spend money and a price list alone does not make that
 * decision for anybody.
 *
 * **The one thing it will not do is invent an audience.** Every instinct of the
 * genre says put "12,000 daily readers" under the hero, and Slash cannot
 * measure that honestly — impression counts arrive aggregated, hours late, and
 * only from browsers that were reopened. So the page sells what is genuinely
 * verifiable instead: hours booked are exact, placements are exclusive, review
 * is by a person, and nothing about readers is collected. That last one is the
 * real differentiator and it leads the page rather than hiding in a footnote.
 *
 * A fabricated number here would be the kind of claim that gets a refund
 * demanded later, and it would contradict the reach section further down the
 * same page.
 */
export function AdvertisePage(): React.JSX.Element {
  const [config, setConfig] = useState<RemoteConfig['advertising'] | null>(null)
  const page = useReveal<HTMLDivElement>()

  useEffect(() => {
    void window.browser.invoke('config:remote', undefined).then((result) => {
      if (result.ok) setConfig(result.value.advertising)
    })
    // Subscribed, not fetched once. An operator changing the rate card while
    // somebody has this page open was previously invisible until they reopened
    // it — and this is the page that quotes prices.
    return window.browser.on('config:changed', (next) => setConfig(next.advertising))
  }, [])

  // The compiled defaults until the served card arrives, so the page is never
  // briefly empty and still works on a build that cannot reach the config.
  const advertising = config ?? DEFAULT_REMOTE_CONFIG.advertising
  const configured = useBrowserStore((s) => s.settings?.advertisePortalUrl) ?? ''
  const sponsorEndpoint = useBrowserStore((s) => s.settings?.sponsorEndpoint) ?? ''
  const activeTabId = useBrowserStore((s) => s.activeTabId)

  const portal =
    configured !== '' ? configured : sponsorEndpoint !== '' ? originOf(sponsorEndpoint) : ''
  const [copied, setCopied] = useState(false)
  const bookingRef = useRef<HTMLElement | null>(null)
  const placementsRef = useRef<HTMLElement | null>(null)
  const [highlight, setHighlight] = useState(false)

  /**
   * Takes somebody to the form and makes it obvious they arrived.
   *
   * Scroll, not a modal, and that is a correctness argument rather than a
   * stylistic one: the composer's signed-out branch opens the Google sign-in in
   * a **new tab**. A modal over this page would be orphaned behind that tab and
   * gone by the time they came back. Scrolling also keeps `CampaignList`
   * reachable, which is where an existing advertiser pays.
   */
  const startBooking = (): void => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    bookingRef.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
    setHighlight(true)
  }

  useEffect(() => {
    if (!highlight) return
    const timer = setTimeout(() => setHighlight(false), 1400)
    return () => clearTimeout(timer)
  }, [highlight])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  // Navigated in a tab rather than handed to the OS. The only channel that
  // reaches `shell.openExternal` deliberately takes a tab id and opens *that
  // tab's* address, so a UI button can never hand the operating system an
  // arbitrary URL.
  const open = (url: string): void => {
    if (!activeTabId) return
    void window.browser.invoke('nav:navigate', { tabId: activeTabId, input: url })
  }

  const mailto = (): void =>
    open(
      `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(
        advertising.contactEmail
      )}&su=${encodeURIComponent('Advertising on Slash')}`
    )

  return (
    <div ref={page} className="glass-page relative h-full overflow-y-auto">
      {/* Hero ---------------------------------------------------------- */}
      <div className="relative">
        <div className="slash-aurora" aria-hidden="true" />
        <div className="slash-dotgrid" aria-hidden="true" />

        <div className="relative mx-auto flex w-full max-w-3xl flex-col items-center px-8 pt-[9vh] text-center">
          <span className="animate-rise inline-flex items-center gap-2 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-3 py-1 text-[11.5px] font-medium text-[var(--color-accent)]">
            <Icon name="sparkle" size={12} />
            Now booking — launch inventory
          </span>

          <h1 className="animate-rise slash-gradient-text mt-5 text-[42px] leading-[1.08] font-semibold tracking-tight">
            The first thing they see,
            <br />
            every time they open a tab.
          </h1>

          <p className="animate-rise mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--color-text-muted)]">
            Buy the start page of a browser by the hour. Live within a day, no agency, no bidding,
            and no auction to lose.
          </p>

          {/*
            One front door.

            This used to be a Gmail compose window, while the real booking form
            sat four hundred pixels below and never received the click. Two
            competing paths on one page, and the more prominent one was the one
            that could not take a booking. The label matches the heading it
            lands on, so somebody who clicks "Book a run" arrives at a section
            called "Book a run".
          */}
          <div className="animate-rise mt-7 flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={startBooking}
              className="cursor-default rounded-xl bg-[var(--color-accent)] px-6 py-3 text-[14px] font-semibold text-black shadow-[0_10px_30px_-10px_var(--color-accent)] transition hover:brightness-110"
            >
              Book a run
            </button>
            <button
              type="button"
              onClick={() => placementsRef.current?.scrollIntoView({ block: 'start' })}
              className="cursor-default rounded-xl border border-[var(--color-border-subtle)] px-5 py-3 text-[14px] transition hover:border-[var(--color-accent)]"
            >
              See placements and rates
            </button>
          </div>

          <p className="animate-rise mt-3 text-[11.5px] text-[var(--color-text-muted)]">
            From ${lowestRate(advertising.placements)} an hour · 24 hour minimum · Reviewed by a
            person before it runs
          </p>
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-3xl px-8 pt-12 pb-24">
        {/*
          Booking, before the argument for booking.
          
          The rest of this page exists to persuade somebody who has not decided.
          Anybody who has should not have to scroll past it, or leave for a
          portal, to do the thing the page is about.
        */}
        <section
          ref={bookingRef}
          id="book"
          className={`slash-reveal mb-14 scroll-mt-8 rounded-2xl transition ${
            highlight ? 'ring-1 ring-[var(--color-accent)]' : 'ring-0'
          }`}
        >
          <CampaignComposer />
        </section>

        {/* The differentiator, stated first ------------------------------ */}
        <section className="slash-reveal mt-2 overflow-hidden rounded-2xl border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/[0.07] p-6">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold">
            <Icon name="shield" size={16} className="text-[var(--color-accent)]" />
            No targeting, and nothing collected
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Slash sends nothing about the reader — no profile, no history, no identifiers. Adverts
            are chosen on the device from a batch every copy of the browser fetches identically, and
            the only thing that ever comes back is a daily count of impressions and clicks.
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            That means <strong>we cannot offer targeting</strong>, and we would rather say so here
            than after you have paid. What you get instead is a placement nobody can skip past,
            beside content the reader chose, in a browser they trust.
          </p>
        </section>

        {/* Why here ------------------------------------------------------ */}
        <section className="slash-reveal mt-14">
          <SectionHeading
            eyebrow="Why Slash"
            title="Four things most inventory cannot offer"
          />
          <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
            {[
              [
                'shield',
                'It cannot be blocked',
                'These are part of the browser, not a request from an ad network. There is no filter list that removes them.'
              ],
              [
                'star',
                'Exclusive by design',
                'Most placements run one or two advertisers at a time. You are not one impression in a rotation of forty.'
              ],
              [
                'clock',
                'Billed on hours, not estimates',
                'An hour either happened or it did not. You are never billed on a number nobody can verify.'
              ],
              [
                'eye',
                'Seen at the start of every session',
                'The start page is the first surface of every new tab, not a slot somebody scrolls past.'
              ]
            ].map(([icon, title, body]) => (
              <div
                key={title}
                className="glass-raised slash-lift flex gap-3.5 rounded-2xl border border-[var(--glass-edge)] p-4"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
                  <Icon name={icon as 'shield'} size={16} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-semibold">{title}</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                    {body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Placements ---------------------------------------------------- */}
        <section ref={placementsRef} className="slash-reveal mt-14 scroll-mt-8">
          <SectionHeading
            eyebrow="Placements"
            title="Pick where you appear"
            body="The highlighted area in each mock is exactly where your advert lands."
          />
          <div className="mt-6 space-y-3">
            {advertising.placements.map((placement, index) => (
              <article
                key={placement.id}
                className="glass-raised slash-lift slash-reveal relative overflow-hidden rounded-2xl border border-[var(--glass-edge)] p-4"
              >
                {index === 0 && (
                  <span className="absolute top-0 right-0 rounded-bl-xl bg-[var(--color-accent)] px-2.5 py-1 text-[10px] font-semibold tracking-wide text-black uppercase">
                    Most visible
                  </span>
                )}
                <div className="flex items-start gap-4">
                  <div className="w-[150px] shrink-0">
                    <PlacementPreview placement={placement.id} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col justify-between gap-3 sm:flex-row sm:items-start">
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-semibold">{placement.name}</h3>
                      <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                        {placement.what}
                      </p>
                      <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
                        <Icon name="lock" size={11} />
                        {placement.concurrency}
                      </p>
                    </div>
                    {/* Nudged down on the first card only: the "Most visible"
                        ribbon occupies that corner, and the price sat behind
                        it. */}
                    <div className={`shrink-0 text-right ${index === 0 ? 'sm:mt-6' : ''}`}>
                      <div className="rounded-xl border border-[var(--glass-edge)] bg-black/20 px-3 py-2">
                        <div className="text-[15px] font-semibold whitespace-nowrap">
                          {placement.rate}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Reach — the honest section ------------------------------------ */}
        <section className="slash-reveal mt-14">
          <SectionHeading eyebrow="Audience" title="How many people will see it" />
          <div className="glass-raised mt-5 rounded-2xl border border-[var(--glass-edge)] p-5">
            {advertising.reachNote !== '' ? (
              <p className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                {advertising.reachNote}
              </p>
            ) : (
              <>
                <p className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                  <strong className="text-[var(--color-text-primary)]">
                    No audience figure is published yet.
                  </strong>{' '}
                  Slash is new, and we would rather say that than quote a number we cannot stand
                  behind — impression counts arrive aggregated and hours late, and only from
                  browsers that were reopened.
                </p>
                <p className="mt-2.5 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                  What you are buying is <strong>time</strong>, not reach: hours booked are exact and
                  verifiable. You will get daily impression and click totals once your campaign
                  runs, labelled as indicative.
                </p>
                <p className="mt-3 rounded-lg bg-[var(--color-accent)]/10 px-3 py-2 text-[12px] text-[var(--color-accent)]">
                  Early inventory is priced accordingly. That is the trade: an unproven audience, at
                  rates that will not last once there is a number to publish.
                </p>
              </>
            )}
          </div>
        </section>

        {/* How it works -------------------------------------------------- */}
        <section className="slash-reveal mt-14">
          <SectionHeading eyebrow="Getting live" title="Four steps, about a day" />
          <ol className="mt-6 space-y-2.5">
            {[
              [
                'Send your creative',
                'An image, a headline, one line of body text and the address it should open. That is the whole brief.'
              ],
              [
                'We review it',
                'Every advert is checked by a person before it can run. Remote images are refused outright — they would be a tracking pixel — so the image is embedded in the batch instead.'
              ],
              [
                'Pick your hours',
                'Whole hours, 24 minimum. You are billed for time booked, because an hour either happened or it did not.'
              ],
              [
                'It goes live',
                'Browsers collect adverts every few hours, so a booking is on screens within one collection.'
              ]
            ].map(([title, body], index) => (
              <li
                key={title}
                className="glass-raised slash-lift flex gap-3.5 rounded-2xl border border-[var(--glass-edge)] p-4"
              >
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-accent)]/15 text-[12px] font-semibold text-[var(--color-accent)]">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-semibold">{title}</h3>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                    {body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Promises ------------------------------------------------------ */}
        <section className="slash-reveal mt-14">
          <SectionHeading eyebrow="Reporting" title="What we can promise" />
          <div className="mt-5 overflow-hidden rounded-2xl border border-[var(--glass-edge)]">
            {[
              ['Hours live', 'Exact. This is what you are billed on.', 'exact'],
              ['Impressions and clicks', 'Daily totals, indicative — labelled as such.', 'soft'],
              ['Anything about readers', 'Nothing. None of it is collected.', 'none']
            ].map(([title, body, kind], index) => (
              <div
                key={title}
                className={`flex items-start gap-3.5 bg-white/[0.03] px-4 py-3.5 ${
                  index > 0 ? 'border-t border-[var(--glass-edge)]' : ''
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                    kind === 'exact'
                      ? 'bg-[var(--color-good)]/20 text-[var(--color-good)]'
                      : kind === 'soft'
                        ? 'bg-[var(--color-warn)]/20 text-[var(--color-warn)]'
                        : 'bg-white/10 text-[var(--color-text-muted)]'
                  }`}
                >
                  {kind === 'exact' ? '✓' : kind === 'soft' ? '~' : '×'}
                </span>
                <div className="min-w-0">
                  <h3 className="text-[13px] font-medium">{title}</h3>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                    {body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Closing action ------------------------------------------------ */}
        <section className="slash-reveal relative mt-14 overflow-hidden rounded-2xl border border-[var(--glass-edge)] bg-white/[0.04] p-7 text-center">
          <div className="slash-aurora opacity-60" aria-hidden="true" />
          <div className="relative">
            <h2 className="text-[20px] font-semibold">Ready when you are</h2>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              Book it here in a few minutes. Somebody reads every advert before it runs, and you are
              not charged until it is approved.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={startBooking}
                className="cursor-default rounded-xl bg-[var(--color-accent)] px-6 py-2.5 text-[13.5px] font-semibold text-black transition hover:brightness-110"
              >
                Book a run
              </button>
            </div>

            {/*
              The email and the portal, demoted to what they are.

              Neither is deleted: email is a genuine lead channel and the fallback
              when the advertising service cannot be reached, and the portal is
              where Stripe lives, which is the one thing that cannot happen in
              the browser. They are no longer *buttons competing with the form*,
              which is what made somebody click "Book a placement" and get a mail
              client.
            */}
            <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
              {advertising.contactEmail !== '' && (
                <>
                  Prefer to talk to a person?{' '}
                  <button
                    type="button"
                    onClick={mailto}
                    className="cursor-default underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-text-primary)]"
                  >
                    Email us
                  </button>{' '}
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(advertising.contactEmail)
                        .then(() => setCopied(true))
                    }}
                    className="cursor-default underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-text-primary)]"
                  >
                    {copied ? 'Copied' : `(${advertising.contactEmail})`}
                  </button>
                  .{' '}
                </>
              )}
              {portal !== '' ? (
                <>
                  Already running a campaign?{' '}
                  <button
                    type="button"
                    onClick={() => open(portal)}
                    className="cursor-default underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-text-primary)]"
                  >
                    Pay or manage it in the portal
                  </button>
                  .
                </>
              ) : (
                'This copy of Slash has no advertiser portal configured, so payment is arranged by email.'
              )}
            </p>
          </div>
        </section>

        <p className="slash-reveal mt-6 text-center text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          Every placement is labelled Sponsored and names who paid for it. Readers cannot switch them
          off — it is how Slash is funded — and nothing about them is collected either way.
        </p>
      </div>
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
