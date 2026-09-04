# Slash sponsor portal

Where companies submit adverts for the Slash start page, and where you approve them.

This is a **separate web application** from the browser. The browser only ever fetches a batch of
approved creatives; everything about who submitted what, and whether it may run, lives here.

```bash
cd portal
npm install
npm start          # http://localhost:4000
```

Then in Slash: **Settings → Earning → Sponsored tiles**, set the endpoint to
`http://localhost:4000/tiles.json` and switch tiles on.

## How the two halves fit

| | |
|---|---|
| `GET /tiles.json` | Every approved campaign, in the exact shape `SponsorBatchSchema` expects. Identical for every caller — no cookie, no parameter, nothing to vary on. |
| `POST /report` | Aggregate counts the browser sends back: per creative, per day. |

That is the whole interface. The browser sends no browsing data, no page address and no identifier,
which is why advertisers can be told **how many times a creative was shown and clicked, per day, and
nothing else**. There is no targeting because there is nothing to target with — say so when you sell
it, because it is unusual and it is the honest pitch.

## Rules enforced in both places

The browser refuses creatives that break these, so the portal refuses them at submission — otherwise
a campaign would sit "approved" here and be silently dropped by every reader:

- **Images must be uploaded, never hot-linked.** A remote `<img src>` would be a request to the
  advertiser's server on every impression — a tracking pixel — and would defeat the batching the
  privacy claim rests on. The form reads the file in the advertiser's browser and stores it as a
  `data:` URL.
- **Landing pages must be `https:`.**

Unknown creative ids in a report are ignored rather than recorded: they would be billing data for a
campaign nobody served.

## Accounts

The **first account to register becomes the operator** and gets the review queue. Everyone after is
an advertiser who can submit campaigns and see their own numbers. Passwords are stored as scrypt
hashes with a per-account salt and compared in constant time; sessions live in the database so
signing out genuinely ends them. A failed sign-in gives one message for both causes, because saying
which half was wrong reveals which addresses have accounts.

## Before this faces the internet

- Put it behind HTTPS and set `SECURE_COOKIES=1`.
- Back up `data/portal.db` — it is one SQLite file, so a copy is a backup.
- Add rate limiting on `/login` and `/signup`. There is none; this is sized for a portal with a
  handful of advertisers, not an open sign-up funnel.
- **Nothing here bills anyone.** It records what was shown and clicked, which is the input to an
  invoice, not an invoice.

## Reality check

Ad revenue is approximately zero below tens of thousands of daily users — sponsors buy audience.
Below that the realistic revenue from a browser is a search partnership, a paid tier, or donations.
See `../docs/LAUNCH.md`.
