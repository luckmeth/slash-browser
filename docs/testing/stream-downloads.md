# Stream downloads — why they failed, and how to check they no longer do

Three complaints, one investigation: YouTube offering only 360p and then failing with
`Server returned 403`, and film sites (123movies, streamm4u) showing an "HLS stream" row whose
Download button produced nothing.

They turned out to be four separate faults, three of them in Slash. None was visible to
`npm run typecheck`, `npm run lint` or the 865 unit tests, because all four are about what a real
server does with a real request.

Reproduce the measurements with:

```bash
SLASH_MEDIA_ACCESS_PROBE=1 npm run dev
```

The probe (`src/main/dev/mediaAccessProbe.ts`) loads three real pages, takes the media URL the
browser itself saw, and fetches it **ten ways** — bare, session-only, user-agent-only,
referrer-only, origin-only, and so on — printing the status of each next to the others. One
variable at a time, because "the headers broke it" is not an answer you can fix.

## What the probe found

### 1. `Sec-Fetch-*` headers make Chromium refuse to send the request at all

| Mode | Result |
|---|---|
| `secfetch` (Sec-Fetch-Dest/Mode/Site) | `net::ERR_INVALID_ARGUMENT` |

They are forbidden header names — Chromium reserves them. A `net.request` carrying one never
leaves the machine. The first version of the fix added them "because that is what a browser
sends", which would have broken **every** download that had an origin to report.

### 2. A referrer with a path makes Chromium cancel the request

Same URL, same host, three referrers:

| `Referer` sent | Result |
|---|---|
| *(none)* | 200 |
| `https://streamm4u.vip/` | 200 |
| `https://streamm4u.vip/movies/doctor-strange-…` | `net::ERR_BLOCKED_BY_CLIENT` |
| `https://example.com/` | 200 |

Chromium's default referrer policy is `strict-origin-when-cross-origin`, and the network service
**verifies** the referrer it is handed against what that policy would produce. A full-path referrer
on a cross-origin request does not match, so the request is cancelled before any server sees it.

The failure is indistinguishable from an ad blocker refusing it — the probe checked, and Slash
Shield's own listener saw the request and let it through every time. `refererFor` now applies the
same policy Chromium does: full URL when same-origin, origin alone when not, nothing on a
downgrade.

### 3. Every redirect was being cancelled, which killed every stream download

`redirect: 'manual'` does not mean "give me the 3xx as a response". It means **the redirect is
cancelled unless `followRedirect()` is called synchronously during the `redirect` event**. Both
downloaders were written as though a 3xx would arrive as a response, so that branch never ran and
every redirecting fetch failed with `Redirect was cancelled`.

Ordinary files rarely redirect, which is why nobody noticed. Streaming CDNs redirect *every
segment*: the film measured here has **1266 segments, each 302 to a different edge host**. One bug,
every stream download on every such site, silently.

| First segment | Before | After |
|---|---|---|
| status | `Redirect was cancelled` | `206 [followed → lh1.stgnvt25.cfd]` |
| bytes read back | 0 | 65536, starting `0x47` — the MPEG-TS sync byte |

### 4. The engine decided "is this a stream?" from the URL, and the URL does not say

`isStreamUrl` requires a `.m3u8` path. The real playlist address was:

```
https://m3u8-play-9str.ppzj-youtube.cfd/hls/1080/642bce…/643792…/1787593765/6316ff454d
```

No extension. The **sniffer already knew** it was a playlist — it classified the response by its
`Content-Type` — and that knowledge was thrown away and re-derived, wrongly, from the path. The
playlist then went down the file path and "downloaded" successfully as a few kilobytes of text.
The caller now says so explicitly (`enqueue({ isStream: true })`).

### 5. YouTube: the addresses are not being withheld, they do not exist

On the watch page in the complaint, the player response listed **30 formats — every one with
neither a `url` nor a `signatureCipher`**:

```
formats: 0, adaptive: 30, withUrl: 0, withCipher: 0
qualities: 1080p, 1080p, 1080p, 720p, 720p, 720p, 480p … (all with no address)
```

This is server-driven delivery: the player negotiates each piece with the server as it plays, so
there is no address on the page for anything to fetch. Slash counted only *signed* formats, so it
reported "0 formats, 0 signed" — which the picker rendered as "there is nothing on this page",
i.e. as though the feature were broken.

`analyseFormats` now counts these separately as `serverDriven`, and the picker says what is
actually true: nothing is being withheld from Slash, the address does not exist until the player
asks for it. Sessions still served the older shape get their formats as before, and the count of
signed ones is now reported **even when something else was offerable** — that was why a page
offering 360p and twenty signed higher resolutions explained nothing at all.

## Manual checks

### A — a film site with a single rendition

1. Open <https://streamm4u.vip/> and start any film.
2. Downloads panel → **Find media**.
3. **Expect:** one row, "HLS stream · joined on download".
4. Press Download.
5. **Expect:** the entry moves through `Joining segment N of 1266` and completes. Open the file.
   **Expect:** it plays, with sound, all the way through — not four seconds and then nothing.
6. **Fail:** "Server returned 403", "Redirect was cancelled", or a file of a few kilobytes that
   opens in a text editor.

### B — a film site that offers several qualities

1. Open a film on a site whose player lists 360p/720p/1080p.
2. Downloads panel → **Find media**.
3. **Expect:** one row **per quality** — "1080p · joined on download", "720p …" — each showing its
   bitrate, not a single row called "HLS stream".
4. Download the 720p row. **Expect:** the finished file is 720p, not the largest variant.
5. **Fail:** one row where the site's own player shows a quality menu. That means the master
   playlist could not be read; check it is not being fetched without the page's referrer.

### C — YouTube

1. Open any watch page and press the download chip.
2. **Expect either** a list of qualities that download and play, **or** a sentence explaining that
   this video's formats carry no address. Both are passes.
3. **Fail:** an empty list with no explanation, or a quality that starts and then fails with 403.
4. Where formats *are* listed and some are signed, **expect** the note to say how many were left
   out and why, alongside the ones that were offered.

### D — nothing else regressed

1. Download an ordinary file from a link (right-click → **Download with Slash (managed)**).
   **Expect:** it completes as before. It now carries the page's referrer, which is what Chromium
   would have sent.
2. Download something from a host that redirects (a GitHub release asset).
   **Expect:** it completes. Before this change it did not.
3. `SLASH_STREAM_PROBE=1` — the synthetic end-to-end check with real ffmpeg — still passes.

## What is still not covered

The probe cannot start 123movies' player: the site opens its real player only after an interaction
that also triggers a popup, and a synthetic click at the iframe's centre reaches a 1×1 placeholder.
Its behaviour is inferred from streamm4u, which is the same class of site and the same delivery
shape, and from the user-reported screenshot showing two HLS rows detected there. Check A on
123movies by hand.
