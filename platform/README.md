# Slash advertising platform

Three pieces, one database:

| | | |
|---|---|---|
| `advertiser/` | Next.js, port 3000 | The public site. Signup, campaign builder, checkout, dashboard. Also hosts the two endpoints the browser talks to. |
| `admin/` | Next.js, port 3001 | Internal tool. Review queue, pricing, remote config, email log. Separate deployment, separate login, not linked from the public site. |
| `supabase/` | SQL | Schema, security policies, seed data. |
| `shared/` | TypeScript | Pricing and batch logic used by both apps. 34 unit tests. |

This **replaces** `../portal`, which was an Express/SQLite prototype. Nothing carries over; delete it
once this is running.

---

## The live project

Supabase project **"Slash Browser"** (`edsuuwzihojdsmgzhzyw`, ap-southeast-1) is set up and running.
All seven migrations are applied, the `campaign-assets` bucket exists, and both apps have a
`.env.local` holding the real URL and keys.

**Those files are gitignored and no key is in this repository.** If the access token used to set
this up was ever shared, rotate it: Supabase → Account → Access Tokens.

Nothing is required to run it locally — see "Run it" below.

---

## Setting it up

### 1. The database — already done

The migrations are applied to the project above. Re-run them only against a *fresh* project; they
are not idempotent.

```
0001_schema.sql            tables
0002_logic.sql             pricing trigger, inventory, scheduling functions
0003_rls.sql               row-level security  ← the important one
0004_storage_and_seed.sql  bucket, starting prices
0005_new_user.sql          advertiser row on signup
0006_sync.sql              encrypted sync storage for the browser
0007_releases.sql          the update feed the browser reads
```

### 2. Make yourself an operator

There is deliberately **no self-serve route** to becoming an admin — that would be a self-serve
route to approving your own adverts. Sign up on the public site first, then in the SQL editor:

```sql
insert into admin_users (auth_user_id, role)
select id, 'owner' from auth.users where email = 'you@yourdomain.com';
```

### 3. Environment

Both `.env.local` files already hold the Supabase URL, keys and a generated `CRON_SECRET`. Two
values are blank and are yours to fill in:

| Variable | Where | Without it |
|---|---|---|
| `STRIPE_SECRET_KEY` | dashboard.stripe.com/test/apikeys | Campaigns save but cannot be paid for, and the builder says so |
| `STRIPE_WEBHOOK_SECRET` | from `stripe listen`, or the webhook endpoint page | Payments succeed at Stripe and nothing happens here |
| `RESEND_API_KEY`, `EMAIL_FROM` | resend.com/api-keys | Nobody is emailed; the email log records the failure |

A blank value means "not configured yet" and is handled as such — the app runs, and only the parts
that genuinely need the key refuse. It does not refuse to start.

`SUPABASE_SERVICE_ROLE_KEY` is already set and **bypasses all row-level security**. Never prefix it
`NEXT_PUBLIC_`; that prefix is what puts a value into the JavaScript every visitor downloads.

### 4. Run it

```bash
cd platform && npm install
npm run test          # 34 tests, no accounts needed
cd advertiser && npm run dev     # http://localhost:3000
cd admin && npm run dev          # http://localhost:3001
```

### 5. Google sign-in (optional)

Supabase → Authentication → Providers → Google. You will need an OAuth client from Google Cloud
Console with `https://YOUR-PROJECT.supabase.co/auth/v1/callback` as the redirect URI. No code
change either way — the button is already there and reports honestly when it is not configured.

---

## Two things that must be running, or it silently breaks

### The scheduled job

`GET /api/cron/advance` is the **only** thing that moves a campaign from approved to running, and
from running to finished. Without it, paid campaigns never start and finished ones are served for
ever. On Vercel, `advertiser/vercel.json` already declares it; elsewhere, any cron:

```bash
curl "https://ads.yourdomain.com/api/cron/advance?key=YOUR_CRON_SECRET"
```

Every 15 minutes is plenty. It is safe to run more often — it only acts on campaigns that actually
crossed a line, so a run with nothing to do emails nobody.

The admin overview shows a red banner if nothing has changed state in over a day while campaigns are
waiting, which is what a stopped cron looks like from the outside.

### The Stripe webhook

Point a webhook at `https://ads.yourdomain.com/api/stripe/webhook` for `checkout.session.completed`
and `charge.refunded`.

**The success redirect is not proof of payment.** It is a URL the buyer's own browser follows —
anyone can visit it with any campaign id. Only the signed webhook marks a campaign paid. Without it
configured, people will be charged and nothing will happen.

Locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`

---

## Connecting the browser

Four endpoints, all served by the advertiser app. Every one is empty-by-default in the browser: a
fresh install contacts none of them.

| Where in Slash | Value | What it does |
|---|---|---|
| Settings → Earning → Sponsor source | `http://localhost:3000/api/tiles` | The batch of adverts |
| Settings → Earning → Advertise link | `http://localhost:3000` | One line on the start page for companies wanting to buy |
| Settings → About Slash → Release feed | `http://localhost:3000/api/updates/latest` | What the update check reads |
| Settings → About Slash → Publisher configuration | `http://localhost:3000/api/config` | Start-page notice, advertise link, feature flags |
| Settings → Privacy → Sync server | `http://localhost:3000/api/sync` | Encrypted bookmarks and reading list |

Swap `localhost:3000` for your domain once it is deployed.

**The last three are the "browser management" half of the operations app.** Without them configured,
the admin app's Releases and Browser-config pages control nothing — which is exactly what they did
before this was wired up.

---

## How the money and the schedule actually work

**Campaigns are sold by the hour, in whole hours, with a per-placement minimum.**

The price is computed by a database trigger from the placement's rate and the window, and the
client's figure is discarded. The same arithmetic lives in `shared/src/pricing.ts` so the buyer sees
the number move as they choose dates — whole hours only, which makes the quote and the charge
identical by construction rather than by rounding the same way in three places and hoping.

**The browser enforces the schedule, not the server.** A batch is fetched every six hours, so an
advert sold for 14:00–15:00 would be invisible to any copy that last asked at 13:00. Instead each
campaign's window travels *with* it in the batch, and every machine starts and stops it on its own
clock. That is why campaigns must start at least `min_lead_time_hours` ahead — a start sooner than
that would not reach the readers it was sold to. This required a change in the browser itself
(`startsAt`/`endsAt` on `SponsoredTileSchema`, migration 19).

**Hours are billed; impressions are not.** Delivery counts arrive aggregated, hours late, and a
browser that is never reopened never sends its share. They are shown to advertisers as indicative
and labelled as such. An hour, by contrast, either happened or did not.

**Images are inlined, never linked.** A remote `<img src>` would be a request to your server every
time the advert appeared, on every machine — a tracking pixel by another name, and the browser
refuses any creative whose image is not a `data:` URL. So creatives are uploaded to a private
bucket and base64-encoded into the batch. That has a real cost: a 500 KB image becomes ~680 KB
encoded, and the batch is a file every user downloads. It is why each placement has a
**maximum at once**, and why raising that number makes the browser slower for people who are not
your customers.

**There is no click tracking.** Readers go straight to the destination. A redirect through your
server would hand you every reader's IP and the exact time they clicked, which is the one thing the
browser's pitch promises it does not collect.

---

## Security notes worth reading before launch

- **`0003_rls.sql` is where the real access control lives.** Policies decide which *rows* an account
  may touch; column grants decide which *columns* it may write. Both are needed: a policy alone
  would let an advertiser set their own campaign's status to `active` or its cost to zero, because
  the row genuinely is theirs. `status`, `total_cost` and `hourly_rate_snapshot` have no update
  grant below the service role.
- **`SUPABASE_SERVICE_ROLE_KEY` bypasses all of it.** It is used in exactly four places, each of
  which acts on nobody's session: the batch endpoint, the report endpoint, the Stripe webhook, and
  the cron. `lib/supabase/service.ts` starts with `import 'server-only'`, so the build fails rather
  than shipping it to a browser.
- **Stripe secrets are in the environment, not `platform_settings`.** A secret in a database row is
  only as protected as the key encrypting it, and that key has to live in an environment variable
  anyway. Storing it in the table would give you two copies of the secret and no extra safety.
- **`browser_settings` is public.** Every copy of the browser reads it unauthenticated, because
  requiring a key would mean each installation carried one — and a per-installation key is an
  identifier. Put nothing in that table that is not already public.
- **`/api/report` is unauthenticated**, for the same reason. The counts are therefore only as
  trustworthy as the anonymous internet, which is exactly why nothing is billed from them.

---

## What has and has not been verified

Honest inventory, so you know where to look first when something misbehaves.

**Verified here:**

- `shared/` — 34 unit tests covering pricing, whole-hour windows, lead time, batch membership,
  the browser's creative rules, and batch size capping.
- Both apps compile and typecheck (`next build` clean).
- The browser-side half — scheduled campaigns, the window enforced on-device — is covered by the
  browser's own suite: **680 tests passing**, typecheck and lint clean.

**Verified against the live project**, with two real advertiser accounts, then cleaned up:

| Check | Result |
|---|---|
| 13 tables created, RLS enabled on every one | 25 policies |
| Advertiser A sees only A's rows; B sees only B's | passes |
| B PATCHes A's campaign | 204, and **zero rows changed** — the title was untouched |
| A sets its own campaign to `active` | **403.** The column grant refuses it |
| A zeroes its own `total_cost` | **403** |
| A reads `platform_settings` | empty — operator-only |
| Pricing computed by the trigger | 24 h × $2.50 = **$60.00**, the client's figure discarded |
| `GET /api/tiles` | an empty batch, correctly shaped |
| `GET /api/config` | the seeded browser settings |
| `GET /api/updates/latest` | 404 — nothing published yet, which is the honest answer |

**Still not verified:** the Stripe checkout and webhook round trip, Resend delivery, and the
storage upload path with the signed URLs the review queue uses. All three need the accounts above.

**Before the first real payment**, run once end to end on test keys: sign up → build a campaign →
pay with `4242 4242 4242 4242` → approve it in admin → confirm it appears in `/api/tiles` → reject
a second one and confirm the refund lands in Stripe.

---

## Reality check

None of this changes the arithmetic: ad revenue is approximately zero below tens of thousands of
daily users, because sponsors buy audience. This is a well-built shop; it does not conjure
customers. A search partnership remains the larger number at your current size. See
`../docs/LAUNCH.md`.
