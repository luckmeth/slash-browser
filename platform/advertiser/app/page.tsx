import Link from 'next/link'
import { formatCents } from '@slash/ad-shared'
import { loadSettings, loadTiers } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/**
 * The page that has to earn the signup.
 *
 * Prices come from `pricing_config` rather than being written here, so the
 * number an operator types into the admin app is the number a visitor reads and
 * the number Stripe charges. Three places that have no business disagreeing.
 */
export default async function LandingPage(): Promise<React.JSX.Element> {
  const [tiers, settings] = await Promise.all([loadTiers(), loadSettings()])

  return (
    <main>
      <h1>Your advert, on the start page of every Slash session.</h1>
      <p className="lede">
        One clearly-labelled tile, shown when somebody opens a new tab. Bought by the hour, live
        within a day, and priced the same for everyone — there is no auction and nobody to
        negotiate with.
      </p>
      <p className="row">
        <Link href="/signup" className="button">
          Start advertising
        </Link>
        <Link href="#how" className="button secondary">
          How it works
        </Link>
      </p>

      <h2 id="why">Why this is different from display advertising</h2>
      <div className="grid">
        <div className="card">
          <h3>No ad blocker stands between you and the reader</h3>
          <p className="note">
            The tile is part of the browser&rsquo;s own start page, not a third-party frame loaded
            into a web page. There is nothing for a blocker to block, because there is no request
            to block.
          </p>
        </div>
        <div className="card">
          <h3>You pay for hours, not impressions</h3>
          <p className="note">
            An hour is a thing that either happened or did not. Impression counting across millions
            of machines is an estimate dressed as a number, and you would be paying for the dressing.
          </p>
        </div>
        <div className="card">
          <h3>No targeting — and we will not pretend otherwise</h3>
          <p className="note">
            Adverts are sent to every machine in a batch and chosen there. Nothing about the reader
            is sent to us, so there is nothing to target on. If precise audience segments are what
            you need, this placement is not it.
          </p>
        </div>
      </div>

      <h2 id="how">How it works</h2>
      <ol className="steps">
        <li>
          <h3>Create an account</h3>
          <p className="note">Email and a password, or your Google account. No sales call.</p>
        </li>
        <li>
          <h3>Build your campaign</h3>
          <p className="note">
            Headline, a supporting line, where it links, and an image you upload. You pick the
            window and see the exact price as you do.
          </p>
        </li>
        <li>
          <h3>Pay</h3>
          <p className="note">
            Card payment through Stripe. You are charged once, for the hours you chose.
          </p>
        </li>
        <li>
          <h3>It goes live</h3>
          <p className="note">
            After a person checks it. You get an email when it starts, and daily figures on your
            dashboard while it runs.
          </p>
        </li>
      </ol>

      <h2 id="pricing">Pricing</h2>
      {tiers.length === 0 ? (
        <div className="card">
          <p className="note">
            No placements are on sale at the moment. Create an account and you will be able to book
            as soon as one opens.
          </p>
        </div>
      ) : (
        <div className="grid">
          {tiers.map((tier) => (
            <div className="card" key={tier.placementTier}>
              <h3>{tier.displayName}</h3>
              <p className="hero-cost">{formatCents(tier.hourlyRateCents, settings.currency)}</p>
              <p className="note">per hour</p>
              <p className="note" style={{ marginTop: 10 }}>
                {tier.description}
              </p>
              <p className="note">
                Minimum booking {tier.minHours} hours ·{' '}
                {formatCents(tier.hourlyRateCents * tier.minHours, settings.currency)}
              </p>
            </div>
          ))}
        </div>
      )}

      <h2>What you get told, and what you do not</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          For each day your campaign runs: how many times it was shown, and how many times it was
          clicked.
        </p>
        <p className="note">
          Those figures arrive in batches and lag by a few hours, and a browser that is never
          reopened never sends its share — so treat them as indicative. They are not what you are
          billed on. You are billed for hours, which is why the two can never quietly disagree.
        </p>
        <p className="note">
          You are not told who saw it, where they were, what else they were reading, or when. Not
          because we withhold it — because the browser never sends it, and there is nowhere for it
          to be collected.
        </p>
      </div>

      <p className="row" style={{ marginTop: 32 }}>
        <Link href="/signup" className="button">
          Create an account
        </Link>
        {settings.supportEmail !== '' && (
          <a className="button secondary" href={`mailto:${settings.supportEmail}`}>
            Ask a question first
          </a>
        )}
      </p>
    </main>
  )
}
