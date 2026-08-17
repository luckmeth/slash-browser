# YouTube ads

What Slash Shield now blocks on YouTube, what it still does not, and why the remainder is an
architectural decision rather than a missing rule.

Reproduce with:

```bash
npm run build && SLASH_YOUTUBE_PROBE=1 npx electron-vite preview
```

## What the probe found

Loading a watch page and recording every request with the filter's decision:

| Request | Before | After |
|---|---|---|
| `googleads.g.doubleclick.net/pagead/id` | BLOCKED | BLOCKED |
| `static.doubleclick.net/instream/ad_status.js` | BLOCKED | BLOCKED |
| `www.youtube.com/ptracking` | **allowed** | BLOCKED |
| `www.google.com/pagead/lvz` | **allowed** | BLOCKED |
| `www.google.lk/pagead/lvz` | **allowed** | BLOCKED |
| `googlevideo.com/videoplayback` | allowed | allowed *(this is the video)* |

3 blocked → 5 blocked on the same page.

## Why domain rules could not reach these

Two separate reasons, both structural:

**First-party.** `www.youtube.com/ptracking` is served by the site you are on. The filter skips
first-party requests deliberately — without that rule, a domain list would cancel a site's own
scripts and break it. So YouTube's ad endpoints were exempt for the same reason ordinary sites work.

**Mixed-purpose hosts.** `www.google.com/pagead/lvz` is ad telemetry, but `google.com` also serves
Search. Blocking the domain is not an option.

The fix is **host + path rules** (`FilterEngine.classifyUrl`), checked *before* the first-party test.
They are deliberately few, because each one bypasses the guard that stops over-blocking; a careless
prefix here takes a working site down. `youtube.com/api/stats/watchtime` is left alone for exactly
this reason — it is playback telemetry, and blocking it loses your resume position.

A rule host may end in `.*` to cover every country domain: `google.*` matches google.com, google.lk
and google.co.uk. The probe caught `google.lk` slipping past a rule written for `google.com`, and
there are roughly 190 of these.

## UPDATE — the pre-roll is now removed, by the mechanism described below

The decision left open below was taken: `YouTubeAdFilter` injects one script into YouTube's own
JavaScript context and deletes the ad-break fields.

### UPDATE 2 — the SPA hole: "ads still play"

The first version worked and was still wrong. It hooked `ytInitialPlayerResponse` (the response
embedded in a watch page's HTML) and `JSON.parse` (text a page parses itself). But YouTube is a
single-page app, and its own navigation — home → video, search → video, video → next video —
fetches the next player response and reads it with **`Response.json()`, which never calls
`JSON.parse`**; it decodes internally. So the strip fired only on a watch page navigated to
*directly*, by pasted link — the least common way to reach one — and a user browsing YouTube
normally kept seeing every ad. Reported as "still youtube ads are playing", and that report was
correct.

The fix hooks `Response.prototype.json` with the same conditional strip (only objects carrying
`streamingData`/`videoDetails`/`adPlacements` are touched). It also seeds the accessor with any
value the page managed to set first, so losing the injection race degrades to "strip late" rather
than "discard the response and break playback".

Verified with `SLASH_YOUTUBE_AD_CAPTURE` against a real watch page:

```
youtube ad probe: PASS — the script ran before the page in its own context
youtube ad probe: strip result {"adPlacements":true,"playerAds":true,"adSlots":true,"keptVideoDetails":true}
youtube ad probe: PASS — ad break fields are removed from the player response
youtube ad probe: PASS — the rest of the player response is untouched
youtube ad probe: fetch-path strip {"adPlacements":true,"playerAds":true,"adSlots":true,"keptVideoDetails":true,"ordinaryJsonUntouched":true}
youtube ad probe: PASS — Response.json() strips the SPA player response
youtube ad probe: PASS — unrelated fetched JSON passes through untouched
youtube ad probe: PASS — JSON.parse strips player responses and nothing else
youtube ad probe: PASS — the player is still present and the page loaded
youtube ad probe: PASS — the script is inert on other sites
```

**What it still does not do:** sponsor segments the creator reads out are part of the video and are
untouched. If YouTube moves to stitching ads into the video stream server-side, this stops working
and no client-side approach replaces it.

The analysis below stands as the record of why network filtering could never have done this.

## What network filtering cannot fix — the pre-roll

**Request blocking alone cannot remove the video ad that plays before your video.** Blocking more
endpoints will not change that, and any claim otherwise would be wrong.

Two things make it unreachable by network filtering:

1. **Ad segments come from the same URL as the content.** YouTube serves both through
   `*.googlevideo.com/videoplayback`. There is no pattern that separates an ad segment from the
   video — a rule that catches one catches the other, and blocking it means nothing plays at all.

2. **The ad breaks are in the page, not in a request.** They arrive inside
   `ytInitialPlayerResponse.adPlacements`, part of the watch page's own HTML document. There is no
   separate request to cancel. The probe reads this field directly:

   ```
   youtube probe: player {"hasAdPlacements":false,"adPlacementCount":0,...}
   ```

   *(That reads false because the probe uses an unmonetised test video. On a monetised one it
   carries the ad breaks.)*

## What removing pre-rolls would actually require

The only mechanism that works is what uBlock Origin does: run a script in the page **before** its own
JavaScript, and delete `adPlacements` / `playerAds` from the player response so the player never
learns it was supposed to show an ad.

That is a real change to this browser's security posture, not a rule addition:

- `preload/content.ts` runs in an **isolated world** (`contextIsolation: true`). Isolated worlds have
  a separate JavaScript context by design, so the preload *cannot* see or modify
  `window.ytInitialPlayerResponse` as the page sees it. That isolation is the thing standing between
  a page and our preload, and it is why the preload is safe to inject everywhere.
- Reaching the page's own context means main-world injection at document-start — a capability that,
  once it exists, is a general "run our script inside every page" mechanism.

This is a deliberate open decision rather than an oversight. It is worth doing only if the
main-world injection is narrowly scoped — one named site, one field deleted, no access granted to
anything else — and it should be a considered choice, not something that appears quietly in a
patch that says "improve YouTube blocking".

## Honest summary for the UI

Slash blocks YouTube's ad *tracking* and *measurement*, and the banner/overlay ads served from
third-party ad domains. It does **not** skip the video ad before your video. The shield panel should
never imply otherwise.

## Regression checks

Re-run `docs/testing/slash-shield.md` and `docs/testing/content-blocking.md`. Confirm specifically:

1. YouTube video playback still works, including seeking.
2. Google Search still works — on `.com` and on a country domain.
3. Resume position on a part-watched YouTube video is still remembered.
