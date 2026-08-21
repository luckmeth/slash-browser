# Sponsored tiles

The one place Slash shows advertising: a single labelled tile on the start page. This document is
for whoever publishes the browser and wants to sell that slot.

**It is inert by default.** It needs *both* the user's switch (`sponsoredTilesEnabled`) and an
endpoint (`sponsorEndpoint`). With either missing, no request is ever made — which is why the
onboarding claim that "nothing leaves this device unless you turn it on" remains literally true on
a default install.

> **If you ship a build with an endpoint preconfigured and tiles switched on, that claim becomes
> false and you must change the copy.** It appears in the first onboarding screen and in the start
> page footer ("Everything here stays on this device"). Shipping either of those next to a browser
> that fetches advert batches on launch is the single fastest way to lose the trust this product is
> built on — far more damaging than the revenue is worth. Either leave it opt-in, or reword both
> to say exactly what leaves and what does not.

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
      "clickUrl": "https://example.com/landing"
    }
  ]
}
```

- `expiresAt` — unix ms. Capped at 7 days regardless of what you send, so a stale batch cannot live
  forever.
- `image` — optional, but **must** be a `data:` URL if present. Keep it small; it is stored and
  inlined on every new tab.
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
