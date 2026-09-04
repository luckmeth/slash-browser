import { PRIVACY_URL, TERMS_URL } from '@shared/types/tab'
import { useReveal } from '../../hooks/useReveal'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * The terms, and what happens to personal information.
 *
 * Written to be read, which is the only thing that makes a document like this
 * worth having: short sentences, no defined-term games, and every promise
 * stated in the same words the product uses. Where something is uncertain it
 * says so — a rewards scheme that "may" become transferable is not the same as
 * one that will, and writing the second because it sounds better is the exact
 * thing regulators read these documents to find.
 *
 * **This is a draft written by the people who built the software, not by a
 * lawyer, and the page says so.** Slash Coin grants future value for present
 * activity and payouts cross borders; both are areas where a real review is
 * needed before anybody is paid. Pretending otherwise in the copy would be the
 * dishonest option.
 */
export function LegalPage({ which }: { which: 'terms' | 'privacy' }): React.JSX.Element {
  const page = useReveal()

  return (
    <div ref={page} className="glass-page relative h-full overflow-y-auto">
      <div className="relative mx-auto w-full max-w-3xl px-8 pt-[7vh] pb-24">
        <p className="text-[11px] tracking-[0.14em] text-[var(--color-text-muted)] uppercase">
          Slash
        </p>
        <h1 className="slash-gradient-text mt-2 text-[34px] leading-tight font-semibold tracking-tight">
          {which === 'terms' ? 'Terms of use' : 'Privacy'}
        </h1>

        <div className="mt-4 rounded-xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/8 p-4">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
            <strong className="text-[var(--color-warn)]">A draft, written in plain language.</strong>{' '}
            It describes exactly what the software does today and is honest about what is not
            decided. It has not been reviewed by a lawyer, and it is not a substitute for one —
            particularly around Slash Coin, which grants future value for present activity, and
            payouts, which cross borders. Nothing here changes what the software actually does; the
            behaviour is the source of truth and this is the description of it.
          </p>
        </div>

        <nav className="mt-5 flex gap-2 text-[12.5px]">
          <Tab label="Terms of use" url={TERMS_URL} active={which === 'terms'} />
          <Tab label="Privacy" url={PRIVACY_URL} active={which === 'privacy'} />
        </nav>

        {which === 'terms' ? <Terms /> : <Privacy />}

        <p className="mt-10 text-[11.5px] text-[var(--color-text-muted)]">
          Last changed with this version of the browser. There is no remote copy that can be edited
          underneath you: these pages ship inside the application, so the terms you read are the
          terms the software you are running was built with.
        </p>
      </div>
    </div>
  )
}

function Tab({ label, url, active }: { label: string; url: string; active: boolean }): React.JSX.Element {
  // Navigates the tab already open rather than making another: these two
  // documents are read against each other, and a tab per click is clutter.
  const tabId = useBrowserStore((state) => state.activeTabId)

  return (
    <button
      type="button"
      onClick={() => {
        if (tabId === null) return
        void window.browser.invoke('nav:navigate', { tabId, input: url })
      }}
      className={`cursor-default rounded-lg px-3 py-1.5 transition ${
        active
          ? 'bg-white/10 text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-muted)] hover:bg-white/5'
      }`}
    >
      {label}
    </button>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="slash-reveal mt-9">
      <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 space-y-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {children}
      </div>
    </section>
  )
}

function Terms(): React.JSX.Element {
  return (
    <>
      <Section title="The browser">
        <p>
          Slash is free to use. It is provided as it is: there is no warranty that it will suit a
          particular purpose, and no promise that it will be free of faults. It is an unsigned build,
          so Windows will warn about the publisher when you install it.
        </p>
        <p>
          You may use it for anything lawful. The features that reach other people&rsquo;s
          services — downloading media, crawling a site, running an AI provider — are yours to use
          within the terms of those services, and using them to breach somebody else&rsquo;s terms is
          your responsibility rather than ours.
        </p>
      </Section>

      <Section title="Slash Coin, in plain terms">
        <p>
          <strong className="text-[var(--color-text-primary)]">
            Coins are points, not money, and they are not a currency, a security or a stake in
            anything.
          </strong>{' '}
          They cannot be bought. During pre-launch they cannot be sold, exchanged or transferred,
          and any value shown beside them is indicative — a figure Slash publishes, not a price
          anybody is bidding.
        </p>
        <p>
          Whether coins ever become transferable is not decided. Nothing on this page or anywhere in
          the software is a promise that they will be, and you should treat time spent collecting
          them as time spent browsing, which you were doing anyway.
        </p>
        <p>
          Earning is opt-in and requires an account and the details on the Slash Coin page. Time
          accrues only while the browser is the active window, the machine is not idle, the page is
          a real one, and you are inside the daily maximum. The rate, the maximum and the launch
          date are set by Slash and can change; changes are not applied backwards to coins already
          collected.
        </p>
        <p>
          Earning can be paused for everyone. When it is, the Slash Coin page says so in as many
          words, and time spent during a pause is not banked and paid out afterwards.
        </p>
      </Section>

      <Section title="One person, one account">
        <p>
          An account is for one person. Running Slash on several machines is fine and expected —
          overlapping time is credited once, not once per machine — but creating accounts to
          multiply earnings, automating activity, or reporting time that was not spent browsing are
          all grounds for suspension.
        </p>
        <p>
          A suspended account keeps its history, keeps reporting, and earns nothing. We do not
          explain which signal caused a suspension, because that would only teach the next attempt
          which signal to change. If you think a suspension is wrong, write to us and a person will
          look at the record.
        </p>
      </Section>

      <Section title="Payouts">
        <p>
          A payout can be requested once your details and a wallet address are on file and your
          balance is over the minimum shown on the page. Requesting one deducts the coins
          immediately, so the balance cannot be claimed twice; if the request is refused they are
          returned in full.
        </p>
        <p>
          The rate is fixed at the moment you ask, not at the moment we pay. Requests are settled by
          a person, not automatically, and we may ask you to prove the wallet is yours before
          sending anything to it — an address nobody has proven is an address anybody could have
          typed.
        </p>
        <p>
          Network fees are deducted from what is sent. A transfer to a wrong or unsupported address
          cannot be reversed by us or by anybody else, which is why the address is checked for the
          right shape before it is saved and why we ask you to check it too.
        </p>
      </Section>

      <Section title="Advertising">
        <p>
          Adverts are bought by the hour, in blocks, at the rate shown when you book. The price is
          calculated by our server from its own rate card; the figure in the browser while you pick
          dates is an estimate of that same calculation.
        </p>
        <p>
          <strong className="text-[var(--color-text-primary)]">Every campaign is reviewed by a person before it runs.</strong>{' '}
          You are not charged until it is approved, so there is never money held for something we
          then turn down. We can refuse a campaign for any reason and will say what it was.
        </p>
        <p>
          You are responsible for what your advert says and for the page it links to. It must be
          lawful and honest, and the link must be https. We do not accept adverts that impersonate
          somebody, that carry malware or deceptive downloads, or that would place us in breach of
          the law where readers are.
        </p>
        <p>
          Delivery figures are indicative. They arrive in batches from browsers that were reopened,
          hours late, and are not audited. We do not sell a number of impressions and do not promise
          one; you are buying a window of time on a placement.
        </p>
        <p>
          Refunds: a campaign that has not started can be cancelled and refunded. One that is
          running is not refundable for time already delivered. If we take a campaign down after it
          has started, we refund the hours that did not run.
        </p>
      </Section>

      <Section title="Changing these terms">
        <p>
          These terms ship inside the browser, so they change when you install a new version. If a
          change materially affects Slash Coin or a campaign you have already paid for, we will say
          so — in the browser and by email to the address on your account.
        </p>
      </Section>
    </>
  )
}

function Privacy(): React.JSX.Element {
  return (
    <>
      <Section title="The short version">
        <p>
          Browsing stays on your machine. History, bookmarks, open tabs, downloads, saved logins and
          addresses are stored in a database in your own user folder and are never sent anywhere.
          There is no analytics in this browser, no telemetry, and no account required to use it.
        </p>
        <p>
          Everything that does leave your machine is something you switched on, and each one is
          listed below.
        </p>
      </Section>

      <Section title="What is sent, and only if you turn it on">
        <p>
          <strong className="text-[var(--color-text-primary)]">Slash Coin.</strong> Signing in sends
          your Google account details to our service, and the browser then reports closed intervals
          of qualifying time — a start, an end, a number of seconds and a device identifier it
          generated itself. It never sends what you were browsing, and private windows never earn
          precisely because that would mean reporting that they happened.
        </p>
        <p>
          <strong className="text-[var(--color-text-primary)]">Your details.</strong> Name, date of
          birth, address, country, phone number and a wallet address, entered by you on the Slash
          Coin page, so a payout has somewhere to go and a name to go under. Readable by you and by
          Slash operators, and by nobody else. Not sold, not shared, and not used for advertising.
        </p>
        <p>
          <strong className="text-[var(--color-text-primary)]">Advertising.</strong> If you book an
          advert, the company details you enter and the creative you upload are stored with the
          campaign.
        </p>
        <p>
          <strong className="text-[var(--color-text-primary)]">Adverts you are shown.</strong> The
          browser fetches a batch of live campaigns every few hours, unauthenticated and identical
          for everyone. Images arrive inside that batch rather than being linked, so displaying an
          advert makes no request to the advertiser and tells them nothing about you. Impression and
          click counts are reported per campaign per day, with nothing identifying who saw it.
        </p>
        <p>
          <strong className="text-[var(--color-text-primary)]">Updates.</strong> The browser asks our
          release feed whether a newer version exists. The request carries no identifier and the
          answer is the same for everybody, so it cannot be used to count installations. Clearing the
          feed address in Settings stops it.
        </p>
        <p>
          <strong className="text-[var(--color-text-primary)]">AI features and sync.</strong> Off
          until you configure them. An AI provider only ever receives page content when you have
          also switched that on separately, and sync uploads only ciphertext — the passphrase never
          leaves your machine, and nobody here can read what you synced.
        </p>
      </Section>

      <Section title="What is never collected">
        <p>
          Your browsing history, the contents of pages, your search terms, your saved passwords, and
          anything at all from a private window. The browser has no mechanism to send any of it, not
          a setting that is turned off.
        </p>
      </Section>

      <Section title="Where it is kept and who can see it">
        <p>
          Data that leaves your machine is stored in our database, hosted on Supabase. Access rules
          in the database restrict every row to the account that owns it; Slash operators can read
          collector and advertiser records in order to answer questions, settle payouts and review
          campaigns, and that access is what the operations application uses.
        </p>
        <p>
          Email is sent through Resend when you sign up as an advertiser, when a campaign is
          approved or rejected, and when a payment is taken. Every send is recorded, including
          failures. You can turn off anything beyond that on the Slash Coin page.
        </p>
      </Section>

      <Section title="Keeping it, and getting rid of it">
        <p>
          Your local data lives until you delete it — clearing browsing data, or removing the
          profile, removes it from the machine and it is not recoverable from us because we never
          had it.
        </p>
        <p>
          For data we hold: ask us and we will send you a copy of everything on your account, or
          delete the account and its personal details. The ledger of earned time is kept in an
          anonymised form after a deletion, because it is the record that stops the same hours being
          claimed twice; it carries no name, address or wallet after that point. Campaign records
          and payment records are kept as long as accounting rules require.
        </p>
      </Section>

      <Section title="Asking us anything">
        <p>
          Write to the support address on the Slash website. A person reads it. If you want your
          data, your account deleted, or an explanation of a suspension, say so plainly and you will
          get a plain answer.
        </p>
      </Section>
    </>
  )
}
