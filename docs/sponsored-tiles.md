# Sponsored tiles

The one place Slash shows advertising: a single labelled tile on the start page. This document is
for whoever publishes the browser and wants to sell that slot.

**It is inert until an endpoint is set.** `sponsoredTilesEnabled` now defaults to **on** and is no
longer exposed to the reader — it survives as the operator's kill switch and as the gate the probes
drive. `sponsorEndpoint` is what actually decides: with no endpoint, no request is ever made, so a
build shipped without one still touches nothing.

> **This warning was acted on, not deleted.** Shipping an endpoint with placements always-on made
> the old copy false, so both claims were narrowed rather than left standing: onboarding now says
> history, bookmarks and passwords stay on the machine and states the advert fetch outright, and the
> start page footer reads "Your history and bookmarks stay on this device". If you change what
> leaves the machine again, these two sentences are the ones to revisit first — they are the most
> quotable claims in the product, and the fastest way to lose the trust it is built on.

## The shape it has, and why

A browser sold on blocking advertising does not get to serve advertising carelessly. Four rules are
enforced in code rather than left to good intentions:

**Batched, never per-impression.** Creatives are downloaded ahead of time and chosen on-device.
The fetch carries no identifier, no cookie, no browsing data and no targeting parameters — the
sponsor learns that *a* copy of Slash asked for tiles, and nothing about who is running it. Showing
a tile makes no request at all.

**Images must be `data:` URLs.** A remote `<img src>` would be a call to the sponsor's server every
time the tile appeared — a tracking pixel wearing a different hat — and would undo the batching
entirely. `SponsorService` **drops any creative whose image is not a data URL**, rather than
trusting the renderer to honour it.

**Click targets must be `https:`.** Anything else is dropped.

**Aggregate reporting only.** Impressions and clicks are counted per creative per *day*. There is
deliberately no finer timestamp, no page, no session and no id — that is the difference between
"this creative was seen 40 times" and a record of when someone opened a tab.

## What your endpoint must return

`GET <sponsorEndpoint>` → JSON:

```json
{
  "expiresAt": 1755820800000,
  "tiles": [
    {
      "id": "spring-campaign-1",
      "sponsor": "Example Co",
      "headline": "Short line of copy",
      "body": "One supporting sentence.",
      "image": "data:image/png;base64,iVBORw0KGgo…",
      "clickUrl": "https://example.com/landing",
      "startsAt": 1755820800000,
      "endsAt": 1755907200000
    }
  ]
}
```

- `expiresAt` — unix ms. Capped at 7 days regardless of what you send, so a stale batch cannot live
  forever. This is when the **batch** goes stale, which is a different thing from when a campaign
  runs.
- `image` — optional, but **must** be a `data:` URL if present. Keep it small; it is stored and
  inlined on every new tab.
- `startsAt` / `endsAt` — optional, unix ms, null or absent for a campaign with no schedule.
  **Enforced on the reader's machine**, half-open: a campaign ending at 15:00 is not shown at 15:00,
  so two campaigns bought back to back never both run for the instant they touch.

  This is what makes selling an advert by the hour possible at all. A batch is fetched at most every
  six hours, so an hour sold for 14:00–15:00 would be invisible to any copy that last asked at
  13:00. Send campaigns *before* they start — a browser holds the window and starts them itself —
  and expect to send anything beginning within about twelve hours of the fetch.

  A window whose end is not after its start is dropped at fetch time rather than never appearing.
- Anything not matching this shape is ignored rather than partially applied.

## What comes back

`POST <sponsorEndpoint>/report` → JSON, exactly this and nothing else:

```json
{ "counts": [{ "tileId": "spring-campaign-1", "day": "2026-08-20", "impressions": 2, "clicks": 1 }] }
```

Counts are cleared only once your server answers 2xx, so a failed report costs a retry rather than
your billing data.

Reporting runs on its **own** schedule, not the batch's. An earlier version only reported when a new
batch was due — every six hours — which meant a browser never open that long accumulated
impressions and reported none of them. The probe caught it; see `SLASH_SPONSOR_PROBE`.

## Testing it

```bash
npm run build && SLASH_SPONSOR_PROBE=1 npx electron-vite preview
```

Runs a local server offering five creatives — three valid, one with a remote image, one with an
`http:` click target — and asserts that the two bad ones are refused, that reading the status does
not rotate the advert, that every cached creative resolves by its own id, that an invented id is
refused, that the fetch carried no cookie or identifier, and that the report body contains counts
and a day and nothing else.

The batch is deliberately **more than one** creative. An earlier version served a single valid tile,
and `rotation % 1` is always `0` — which hid a bug where reading the status rotated the batch, so a
click resolved against a different advert, was billed, and opened nothing.

## What this will and will not earn

Worth saying plainly, because it affects whether building the sales side is worth your time:

**Ad revenue is approximately zero below tens of thousands of daily users.** Sponsors buy audience.
Below that, the realistic revenue from a browser is a search-engine partnership (how Firefox, Brave,
Vivaldi and Opera are actually funded — Ecosia, DuckDuckGo, Brave Search and Startpage all run
partner programmes with lower barriers than Google), a paid tier, or donations.

**Programmatic networks will not work here.** Google AdSense and similar do not permit serving into
a desktop application surface; attempting it risks account termination. This slot has to be sold as
**direct deals**, which needs a business entity that can invoice.

**Auto-update and code signing gate all of it.** You cannot grow an audience or ship inventory to
one without them, and no sponsor buys an audience that cannot be updated.



didnt you fix and changed the admin app get the memory form past conversations