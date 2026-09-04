import Link from 'next/link'
import { formatCents } from '@slash/ad-shared'
import { loadSettings, loadTiers } from '@/lib/settings'
import { NewTabPreview } from '@/components/NewTabPreview'

export const dynamic = 'force-dynamic'

/**
 * The page that has to earn the signup.
 *
 * It leads with the product rather than a description of it: the first thing a
 * buyer sees is a scale model of the start page with an advert in it, labelled
 * exactly as it will be. Everything after that is detail for somebody who is
 * already interested.
 *
 * Prices come from `pricing_config` rather than being written here, so the
 * number an operator types into Slash Operations is the number a visitor reads
 * and the number Stripe charges. Three places that have no business disagreeing.
 */
export default async function LandingPage(): Promise<React.JSX.Element> {
  const [tiers, settings] = await Promise.all([loadTiers(), loadSettings()])

  // The headline placement leads, because it is the one being sold hardest.
  const ordered = [...tiers].sort((a, b) => b.hourlyRateCents - a.hourlyRateCents)
  const headline = ordered[0]

  return (
    <main>
      <section className="hero" style={{ marginTop: 0 }}>
        <div className="hero-grid">
          <div>
            <span className="eyebrow">Advertise on Slash</span>
            <h1>The first thing every user sees, every time they open a tab.</h1>
            <p className="lede">
              Your brand on the start page of the Slash browser. Bought by the hour, live within a
              day, and priced the same for everyone — there is no auction, no agency, and nobody to
              negotiate with.
            </p>
            <p className="row">
              <Link href="/signup" className="button big">
                Start advertising
              </Link>
              <Link href="#pricing" className="button secondary big">
                See pricing
              </Link>
            </p>
            {headline && (
              <p className="note" style={{ marginTop: 18 }}>
                From {formatCents(headline.hourlyRateCents, settings.currency)} an hour ·{' '}
                {headline.minHours}-hour minimum · card payment, no contract
              </p>
            )}
          </div>

          <div>
            <NewTabPreview
              headline="Your headline, on every new tab"
              body="A supporting line in your own words."
              sponsor="Your company"
            />
            <p className="note" style={{ marginTop: 12, textAlign: 'center' }}>
              Exactly how it appears — including the label. We do not disguise advertising.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2>Why this beats display advertising</h2>
        <p className="lede">Three differences, and all of them are structural rather than a claim.</p>
        <div className="grid">
          <div className="card lift">
            <h3>No ad blocker stands in the way</h3>
            <p className="note">
              The placement is part of the browser&rsquo;s own start page, not a third-party frame
              loaded into a web page. There is nothing for a blocker to block, because there is no
              request to block.
            </p>
          </div>
          <div className="card lift">
            <h3>You pay for hours, not estimates</h3>
            <p className="note">
              An hour either happened or it did not. Counting impressions across millions of
              machines is an estimate dressed as a number, and you would be paying for the dressing.
            </p>
          </div>
          <div className="card lift">
            <h3>People who chose their tools</h3>
            <p className="note">
              Slash users deliberately picked a privacy-first browser over the default one already
              on their machine. They are the kind of audience that reads before it clicks.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2>Live in four steps</h2>
        <ol className="steps">
          <li>
            <h3>Create an account</h3>
            <p className="note">Your Google account, or an email and a password. No sales call.</p>
          </li>
          <li>
            <h3>Build your campaign</h3>
            <p className="note">
              Headline, a supporting line, where it links, and an image you drag in — with a live
              preview of the real start page as you type.
            </p>
          </li>
          <li>
            <h3>We review it</h3>
            <p className="note">
              A person reads every campaign. <strong>You are not charged for this</strong> — payment
              comes after approval, so nothing is taken for something we turn down.
            </p>
          </li>
          <li>
            <h3>Pay, and it runs</h3>
            <p className="note">
              Card payment through Stripe, once, for the hours you chose. An email when it goes
              live, and daily figures on your dashboard.
            </p>
          </li>
        </ol>
      </section>

      <section id="pricing">
        <h2>Pricing</h2>
        <p className="lede">
          The same rate for everyone, published here, and charged exactly as shown. Sold in whole
          hours with a minimum block per placement.
        </p>

        {ordered.length === 0 ? (
          <div className="card">
            <p className="note" style={{ margin: 0 }}>
              No placements are on sale at the moment. Create an account and you will be able to
              book as soon as one opens.
            </p>
          </div>
        ) : (
          <div className="grid">
            {ordered.map((tier, index) => (
              <div
                className={index === 0 ? 'card featured lift' : 'card lift'}
                key={tier.placementTier}
              >
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ margin: 0 }}>{tier.displayName}</h3>
                  {tier.maxConcurrent === 1 && <span className="badge">Exclusive</span>}
                </div>
                <p className="hero-cost">
                  {formatCents(tier.hourlyRateCents, settings.currency)}
                  <span className="note" style={{ fontSize: 14, fontWeight: 400 }}>
                    {' '}
                    / hour
                  </span>
                </p>
                <p className="note" style={{ marginTop: 12 }}>
                  {tier.description}
                </p>
                <p className="note" style={{ marginTop: 12 }}>
                  Minimum {tier.minHours} hours ·{' '}
                  <strong style={{ color: 'var(--muted)' }}>
                    {formatCents(tier.hourlyRateCents * tier.minHours, settings.currency)}
                  </strong>{' '}
                  to start
                  {tier.maxConcurrent === 1
                    ? ' · yours alone for the whole booking'
                    : ` · up to ${tier.maxConcurrent} advertisers at once`}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>What you are told, and what you are not</h2>
        <p className="lede">
          Worth reading before you buy, because it is unusual — and because being straight about it
          is the whole pitch.
        </p>
        <div className="ledger">
          <div>
            <span className="yes">Yes</span>
            <span>
              <strong>Hours live</strong> — exact, and what you are billed on.
            </span>
          </div>
          <div>
            <span className="yes">Yes</span>
            <span>
              <strong>Impressions and clicks, per day.</strong> They arrive in batches and lag a few
              hours, and a browser that is never reopened never sends its share — so treat them as
              indicative. They are shown to you; they are not what you pay for.
            </span>
          </div>
          <div>
            <span className="no">No</span>
            <span>
              <strong>Who saw it, where they were, or what else they were reading.</strong> Not
              withheld — never collected. The browser chooses your advert on the reader&rsquo;s own
              machine and sends us nothing about them.
            </span>
          </div>
          <div>
            <span className="no">No</span>
            <span>
              <strong>Targeting or audience segments.</strong> There is nothing to target on. If
              precise segments are what you need, this placement is not it, and we would rather say
              so now than take your money.
            </span>
          </div>
          <div>
            <span className="no">No</span>
            <span>
              <strong>Click-tracking redirects.</strong> Readers go straight to your site. Nothing
              of ours sits in between.
            </span>
          </div>
        </div>
      </section>

      <section className="tight">
        <div className="card featured" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <h2 style={{ marginBottom: 10 }}>Book your first hours</h2>
          <p className="lede" style={{ margin: '0 auto 24px' }}>
            An account takes a minute, and you see the exact price before anything is charged.
          </p>
          <p className="row" style={{ justifyContent: 'center' }}>
            <Link href="/signup" className="button big">
              Start advertising
            </Link>
            {settings.supportEmail !== '' && (
              <a className="button secondary big" href={`mailto:${settings.supportEmail}`}>
                Ask a question first
              </a>
            )}
          </p>
        </div>
      </section>
    </main>
  )
}
