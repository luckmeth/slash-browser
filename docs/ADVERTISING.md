# Slash advertising — the whole product, specified

The document to hand to anybody (or anything) picking this up. It states what exists, what is
being added, and the decisions behind both.

---

## 1. What this is

Companies buy the **background of the Slash new-tab page**. Every time somebody opens a tab, they
see it. One clearly-labelled advertiser at a time, sold by the hour, self-serve from end to end —
no salesperson, no bidding, no agency.

Three applications, one database:

| | | |
|---|---|---|
| **Slash browser** | Electron | Shows the advert. Everything else about it is local-first and personal |
| **Advertiser portal** | Next.js, public | Where companies sign up, build a campaign, pay, and watch it run |
| **Slash Operations** | Next.js in Electron, a Windows `.exe` | Where you review, price, approve, and manage the browser fleet |
| **Supabase** | Postgres + Auth + Storage | Shared by all three |

### Multi-tenancy, stated precisely

Every person running Slash gets **their own browser**: their own history, bookmarks, passwords,
settings, workspaces, profiles. None of it is shared, none of it is uploaded, and the browser is
fully usable with every network feature switched off.

The **only** thing common to all of them is the advert on the new-tab page. That is the whole of
the shared surface, and it is the product being sold.

---

## 2. The journey, end to end

### For the company

1. **They see it.** The new-tab page carries a *Post your ad — reach every Slash user* card.
   Visible on every install where the publisher has configured the portal address.
2. **They sign in.** Google, or email and password. Google is the default path — a company
   buying advertising should not have to invent a password first.
3. **They tell you who they are.** Company name, contact, billing email, website.
4. **They build the campaign.** Headline, supporting line, destination URL, and a background image
   **dragged and dropped**, with a live preview of exactly how the new-tab page will look.
5. **They choose when and how long.** A calendar showing what is already booked, an hourly rate,
   a live total. Minimum block per placement.
6. **They submit.** Status `pending_review`. An email goes out: *we have your campaign*.
7. **You review it** in Slash Operations, seeing the creative rendered as readers will see it.
8. **You approve.** Status `approved_unpaid`. An email goes out: *approved — pay to go live*.
9. **They pay.** Stripe Checkout. The signed webhook — not the redirect — marks it paid and the
   campaign becomes `scheduled`.
10. **It goes live** at its start time. An email goes out: *your advert is live on Slash*.
11. **They watch it.** Impressions and clicks per day on their dashboard.
12. **It ends.** An email a few hours before, offering to extend.

> **Review before payment, not after.** Taking money and then refusing the advert means holding
> somebody's money for something you rejected, and needing a refund path for the ordinary case.
> Approving first costs one extra email and removes the whole problem.

### For the person using the browser

They open a tab. There is a background image, a headline, and the word **Sponsored** with the
company's name. Clicking it opens the advertiser's site. That is all — and one switch in Settings
turns it off entirely.

---

## 3. Placements and pricing

Sold **by the hour**, in whole hours, with a minimum block. Three tiers:

| Tier | What it is | Concurrency | Suggested start |
|---|---|---|---|
| `newtab_background` | The full new-tab backdrop. The premium placement | **1 — exclusive** | $12/hour, 24 h minimum |
| `newtab_feature` | The first tile position, above the rotation | 2 | $4/hour, 24 h minimum |
| `home_banner` | A tile in the rotation | 6 | $2.50/hour, 24 h minimum |

Every number is editable in Slash Operations and takes effect immediately — the public pricing page
reads the same table Stripe is charged from.

### Why hourly, and why exclusive

- **An hour either happened or it did not.** Impression counts arrive aggregated and hours late,
  and a browser that is never reopened never reports at all. Billing on them would mean invoicing
  from a number you cannot stand behind. Time is verifiable; that is the whole argument.
- **Exclusivity is what makes the background worth paying for.** Rotating it between four
  advertisers quarters the value and quadruples the download every user takes. One at a time.
- **A 24-hour minimum** stops bookings worth less than the card fee on them, and — because the
  browser collects adverts every six hours — keeps every purchased hour long enough to be delivered.

### What you can honestly promise

- Hours live: exact.
- Impressions and clicks per day: indicative, and labelled as such in the UI.
- Nothing else. There is no targeting, because nothing about the reader is ever sent. Say so when
  you sell it — it is unusual, and it is the honest pitch.

---

## 4. The value proposition, for the public site

Written to sell, and all of it true:

- **A full-screen placement nobody scrolls past.** Not a banner competing with content — the
  background of a page every user sees, several times a day, at the moment they are choosing where
  to go next.
- **Ad blockers cannot touch it.** It is part of the browser's own start page, not a third-party
  frame loaded into a web page. There is no request to block.
- **You pay for time, not for estimates.** An hour is a fact. Impression counting across millions
  of machines is an estimate wearing a number's clothes.
- **Live in a day, self-serve.** No agency, no insertion order, no minimum spend negotiation.
- **Transparent, fixed pricing.** The same rate for everyone, published on the site.
- **An audience that chose a privacy-first browser** — people who deliberately picked their tools.
- **No targeting, and we will not pretend otherwise.** If precise audience segments are what you
  need, this is not the placement.

---

## 5. Payments

**Stripe Checkout**, redirect flow. Never a custom card form: PCI compliance is Stripe's problem
and should stay that way.

- The **signed webhook** (`checkout.session.completed`) is the only thing that marks a campaign
  paid. The success redirect is a URL the buyer's own browser follows — anyone can visit it with
  any campaign id.
- **Keys are entered in Slash Operations**, encrypted at rest, and can be swapped between test and
  live without a rebuild. Nothing is hardcoded and no key ships in any binary.
- Until keys are entered, the whole flow works in test mode and says so on screen. Somebody who
  believes they are taking real money while running in test finds out at the end of the month,
  from their bank.

## 6. Email — Resend

**Use Resend.** Clean API, React Email templates, generous free tier, good deliverability at this
size. The alternatives, honestly:

| | |
|---|---|
| **Postmark** | Better deliverability for transactional mail, and it is the one to move to if messages start landing in spam. Pricier, and it does not matter until it does |
| **AWS SES** | Cheapest at volume, worst developer experience, and you own the reputation management |
| **SendGrid** | No reason to choose it over Resend today |

Every send is recorded in `email_log` — type, recipient, campaign, success or failure with the
reason. "Did they get the receipt?" is otherwise unanswerable, and the first time anybody asks is
when somebody says they were charged without being told.

Six messages: welcome · campaign received · approved, pay to go live · payment received · your
advert is live · ending soon.

---

## 7. Slash Operations — what an operator actually needs

The app exists and is a Windows `.exe`. What it must do well:

- **Review queue.** The creative rendered exactly as a reader sees it — full-bleed background with
  the headline over it — beside the company, the dates, the price, and the destination URL in full
  text (never as a link: a link whose text and target differ is the oldest trick there is).
- **Companies.** Every advertiser, their spend, their campaign history, and a way to suspend one.
- **Calendar.** What is booked, when, and which hours are still free. Selling the background twice
  over is the failure that costs you a customer rather than a support ticket.
- **Pricing.** Rates, minimums and concurrency per tier, with a history of what changed and when.
- **Payments.** Stripe keys, test/live mode, and every transaction with its status.
- **Releases.** Publish a browser version; the update feed serves it.
- **Browser config.** The start-page notice, feature flags, whether the *Post your ad* card shows.
- **Email log.** Every send, with failures visible rather than swallowed.

It must be **readable at a glance**: an operator opening it should see what needs their attention
without hunting. Numbers large, labels quiet, one clear action per row.

---

## 8. Build status

| | |
|---|---|
| Supabase schema, RLS, storage | **Built.** 13 tables, RLS on every one, 25 policies, verified against the live project with two real accounts |
| Advertiser signup, Google sign-in | **Built** |
| Drag-and-drop creative upload with preview | **Built** |
| Campaign builder, live cost | **Built** |
| Stripe Checkout + signed webhook | **Built**, needs keys |
| Six transactional emails + log | **Built**, needs a Resend key |
| Advertiser dashboard | **Built** |
| Operations app as a Windows `.exe` | **Built** |
| Review queue, pricing, releases, browser config, email log | **Built** |
| Batch, report, config and update endpoints | **Built** and verified |
| Browser: scheduled campaigns, sponsored tile, advertise link | **Built** |
| — | — |
| **New-tab background placement** | **To build.** Currently a tile |
| **"Post your ad" card on the start page** | **To build.** Currently one line of text |
| **Review before payment** | **To change.** Currently payment then review |
| **Stripe keys entered in Operations** | **To build.** Currently environment variables |
| **Booking calendar and availability** | **To build** |
| **Companies screen** | **To build** |
| **Operations UI pass** | **To do** |

---

## 9. Things worth adding, in order of what they return

1. **A booking calendar the advertiser can see.** Removes the commonest support question and makes
   the exclusivity feel real.
2. **Invoice PDFs.** Companies need them for their own books, and asking you by email for one is
   friction on both sides.
3. **Renewal in one click** from the ending-soon email.
4. **A creative preview link** the advertiser can send their own colleagues before submitting.
5. **Rate limiting and email verification on signup.** Not urgent with a handful of advertisers,
   necessary the day the portal is public.
6. **A Slack or email alert** when something lands in the review queue.
7. **Multi-currency**, once there is a second country's advertiser asking.

Deliberately **not** on this list: click-tracking redirects, retargeting pixels, and audience
segments. Each would break the one claim that makes this placement distinctive.
