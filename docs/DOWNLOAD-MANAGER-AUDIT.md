# Download manager — repository audit and integration plan

**Phase 1 + 2 deliverable. No code was changed to produce this.** Every claim below was checked by
finding the code; every "missing" claim by failing to find it. Where an existing document disagrees,
this file says so and names the file.

## Baseline, recorded before anything changes

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` (3 projects) | clean |
| Lint | `npx eslint .` | clean |
| Tests | `npx vitest run` | **54 files, 865 tests, all passing** |
| Build | `electron-vite`, 3 main entries (`index`, `embeddingWorker`, `filterCompiler`) | builds |

Any regression against those numbers is a defect, not a trade-off.

---

# Part 1 — Architecture map

## Framework and process model

Electron 43 (Chromium 150, Node 24.18), React 19, TypeScript 5.9, Vite 7 / electron-vite 5,
Tailwind 4, Zustand 5, zod 4, better-sqlite3 13. CJS output for main and preload (no
`"type": "module"`), which is load-bearing for the native module and the sandboxed preloads.

Three view layers per window: **chrome view** (React app, full bounds) → **page view**
(`WebContentsView`, inset into the chrome's content hole) → **overlay view** (transparent, full
bounds, hidden by default). Anything that must visually cover a web page renders in the overlay,
because a native view cannot be covered by CSS `z-index`.

## Network layer — what is available and who already owns it

| API | Owner | Notes |
|---|---|---|
| `session.webRequest.onBeforeRequest` | `NetworkPolicy` (`src/main/shield/`) | **Taken.** Electron allows one listener per event per session. Ad/tracker blocking, malicious-host refusal, path rules. |
| `session.webRequest.onResponseStarted` | `MediaSniffer` (`src/main/media/`) | **Taken.** Filtered at registration to `media`/`xhr`/`object` — the filter is the performance story, not the callback body. |
| `session.on('will-download')` | `DownloadManager` (`src/main/downloads/`) | Chromium's own downloads; decides takeover. |
| `net.request` | `SegmentedDownload`, `StreamDownload`, `requestContext.ts` | Goes through Chromium's stack — same proxy, TLS, DNS as the browser. |
| Sessions / partitions | `SessionRegistry` (`src/main/sessions/`) | **Every session must come from here.** It applies `SessionHardening` first. |
| Cookies | implicit, via `net.request({ session, useSessionCookies: true })` | No direct cookie-jar manipulation anywhere, and there should not be. |

There is **no second networking stack** and there must not be one.

## Current download and media stack, layer by layer

```
webRequest.onResponseStarted ──► MediaSniffer ──► MediaLedger (per tab, generation-tagged)
                                      │
page's own JS  ──► PageMediaExtractor ─┤
                                      ▼
                          AppContext.mediaOptionsFor()  ◄── readStreamVariants() (HLS master)
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
             MediaPicker (overlay)              GuardianPanel (side panel)
                    │                                   │
                    └──────────► IPC ◄──────────────────┘
                                  │
                          DownloadQueue.enqueue()
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
            SegmentedDownload            StreamDownload
            (ranges, N connections)      (HLS segments, in order)
                    │                           │
                    └────────► Muxer (ffmpeg -c copy, video+audio) ─► file
```

### Detection

| Component | File | What it does |
|---|---|---|
| `MediaSniffer` | `src/main/media/MediaSniffer.ts` | Response observer. Filtered to `media`/`xhr`/`object`. Dedupes by URL — a playing video re-requests the same URL several times a second. |
| `MediaLedger` | `src/main/media/mediaSniffing.ts` | Per-tab store, **generation-tagged** so SPA route changes (clicking the next YouTube video) do not lose media that arrives either side of the change. |
| `classifyMedia` | `src/main/media/mediaSniffing.ts` | Pure classifier → `file` / `stream` / `protected`. Already uses **Content-Type first**, URL path second. Drops segments (`.ts`, `.m4s`, `.cmfv`, `.cmfa`) so a film is not 1266 rows. |
| `PageMediaExtractor` | `src/main/media/PageMediaExtractor.ts` | Reads `ytInitialPlayerResponse` in the page's own world. Hostname-gated, user-initiated only, read-only. |
| `pageFormats.ts` | `src/main/media/pageFormats.ts` | Pure. Splits formats into offerable / `signed` / `serverDriven`. |
| `DownloadGuardian` | `src/main/downloads/guardian/` | DOM scan for download links + link-safety verdicts. Merges with sniffer output in `scanMedia`. |

### Streaming

| Component | File | Coverage |
|---|---|---|
| HLS parsing | `src/main/media/hlsPlaylist.ts` | Master + media playlists, `BANDWIDTH`/`RESOLUTION`/`CODECS`, `#EXT-X-MAP`, `#EXT-X-BYTERANGE`, `#EXT-X-KEY` (refused, not decrypted), live detection, relative/absolute URIs. **209 lines of tests.** |
| HLS planning | `StreamDownload.planStream` | Master → best variant → segments, or a refusal with a reason. |
| HLS transfer | `StreamDownload.run` | 4 concurrent fetches, **written strictly in order**, held in memory until their turn. |
| Variants for the UI | `StreamDownload.readStreamVariants` | Recently added; feeds per-quality rows. |
| DASH | — | **Recognised in order to be excluded.** `classifyMedia` labels `.mpd`/`application/dash+xml` as a stream; nothing parses it. |

### Transfer engine

| Component | File | Coverage |
|---|---|---|
| `SegmentedDownload` | `src/main/downloads/engine/SegmentedDownload.ts` | Ranged probe (`bytes=0-0`, reads total from `Content-Range`), N connections writing at their own offsets into one preallocated file, bandwidth throttle, cooperative pause/cancel, SHA-256. |
| `planning.ts` | `src/main/downloads/engine/planning.ts` | Pure: `readCapabilities`, `planConnections`, `planSegments`, `resumeIsSafe`, `retryDelayMs`, `safeFilename`, `categorise`, `isStreamUrl`, `withExtension`. **321 lines of tests.** |
| `requestContext.ts` / `requestHeaders.ts` | same directory | Session + cookies + UA + policy-correct `Referer`; `sendMediaRequest` follows redirects and records each hop. |
| `Muxer` | `.../Muxer.ts` | Bundled ffmpeg, remux only (`-c copy`). Absent binary degrades to two files with a stated reason. |
| `DownloadQueue` | `.../DownloadQueue.ts` | Concurrency cap 3, priority ordering, `startAfter` scheduling with a single armed timer, retry with backoff (max 4), joined video+audio as one row. |
| `DownloadManager` | `src/main/downloads/DownloadManager.ts` | Chromium's own downloads; persists to SQLite; `shouldTakeOver` hands >4 MB to the engine. |

### Persistence

| Table | Migration | Holds |
|---|---|---|
| `downloads` | v1, `src/main/db/migrations/index.ts:84` | **Chromium `DownloadItem` rows only.** id, url, filename, save_path, mime, totals, state, dangerous flag, timestamps. |

24 migrations exist; `LATEST_SCHEMA_VERSION` is derived from the array. There is **no table for
engine downloads, and no segment table.**

### IPC and security boundary

`src/main/ipc/registry.ts` is the only file permitted to call `ipcMain.handle`. Three guarantees:
sender allowlist by WebContents identity (chrome/overlay only — page views are never registered),
zod validation of every payload, `Result` wrapping so nothing throws across the boundary.
`src/shared/ipc/contracts.ts` is the single source of truth for channels and schemas.

Existing engine channels: `downloadEngine:list` / `enqueue` / `pause` / `resume` / `cancel` /
`remove` / `setPriority` / `clearFinished` / `startNow`, plus the `downloadEngine:changed` event.
Media channels: `media:offer` / `openPicker` / `options` / `downloadChoice` / `dismissOffer` /
`detected`, and `guardian:scanDownloads` / `scanMedia`.

Two anti-tamper measures already exist and must be preserved: `window.rememberMediaChoices` records
what was actually offered so the renderer cannot ask the browser to fetch an arbitrary URL, and both
enqueue paths reject anything that is not `http(s)`.

### UI

| Surface | File | Role |
|---|---|---|
| Downloads Center | `src/renderer/features/downloads/DownloadsCenter.tsx` | Engine transfers: filters, progress, speed, ETA, connection note, pause/resume/cancel/remove. |
| Guardian panel | `.../GuardianPanel.tsx` | Link scan, "Find media", detected-media rows with Download buttons. |
| Downloads panel | `src/renderer/features/panels/DownloadsPanel.tsx` | Chromium downloads list. |
| Media chip | `src/renderer/features/media/MediaOfferChip.tsx` | **Overlay surface** (`media-offer`), non-modal, corner-sized. |
| Media picker | `.../MediaPicker.tsx` | Modal overlay: quality list + honest refusals. |

Panels live in the chrome document and **inset the page view** via `layout:setRightPanelWidth`;
anything that must float goes in the overlay instead.

---

# Part 2 — Gap analysis against the 23 requirements

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Auto-detect downloadable files | **Built** | `MediaSniffer` + `DownloadGuardian` |
| 2 | Auto-detect playable media | **Built** | `classifyMedia`, Content-Type first |
| 3 | Detect HLS | **Built** | `classifyMedia` matches `mpegurl` MIME *and* path |
| 4 | HLS master → expose qualities | **Built (new)** | `readStreamVariants` → `withStreamQualities` |
| 5 | DASH where accessible | **Missing** | Recognised, never parsed |
| 6 | Direct MP4/WebM/audio | **Built** | `classifyMedia` |
| 7 | Follow 3xx correctly | **Built (new)** | `sendMediaRequest`; was cancelling every redirect |
| 8 | Preserve session context | **Built (new)** | `requestContext.ts` |
| 9 | Resumable downloads | **BROKEN** | see D-1 |
| 10 | Range requests | **Built** | `SegmentedDownload.probe`/`fetchSegment` |
| 11 | Parallel/multipart | **Built** | `planConnections`, 1–8 |
| 12 | Intelligent retry | **Partial** | `retryDelayMs`, max 4 — but retries all errors alike; a 404 gets four attempts |
| 13 | Persist download state | **MISSING** | engine state is an in-memory `Map` |
| 14 | Resume after restart | **MISSING** | nothing is written, nothing is restored |
| 15 | Queue management | **Built** | priorities, cap 3, `startNow` |
| 16 | Pause/resume/cancel/retry | **Partial** | pause/cancel work; resume restarts from zero (D-1) |
| 17 | Bandwidth throttling | **Built** | `downloadBandwidthLimit`, per-chunk sleep |
| 18 | Scheduling | **Built** | `startAfter` + single armed timer |
| 19 | Speed/progress/ETA/status | **Built** | `DownloadsCenter` |
| 20 | Detect by activity, not extension | **Mostly** | classifier is MIME-first; **the engine's `isStreamUrl` is still extension-only** (D-2 mitigated, not removed) |
| 21 | Integrated into browser UI | **Built** | chip → picker → panel |
| 22 | Professional dialog | **Partial** | quality list exists; no destination chooser, no size/audio-track detail (D-5) |
| 23 | Maintainable, modular | **Built** | pure logic separated from Electron throughout |

---

# Part 3 — Defects confirmed during the audit

These were found by reading code, not by guessing. Each names its evidence.

### D-1 — Pause/resume destroys the download and writes a second file *(critical)*

`DownloadQueue.resume()` only sets the state back to `queued`. `pump()` then calls `begin()`, which:

1. re-runs `uniquePath()` — the partial file now exists, so the destination becomes `file (1).ext`;
2. constructs a fresh `SegmentedDownload`;
3. `run()` opens the destination with flag `'w'` and truncates it.

So pausing a 3 GB download at 90% and resuming it starts again from zero, **into a different file**,
leaving the first partial behind. `SegmentedDownload.resume()` — which exists, calls `resumeIsSafe`,
and is correct — **is never called from anywhere** (`grep -rn "\.resume(" src/main` returns only
`DownloadQueue.resume`, `DownloadManager` and the two IPC handlers).

`docs/DOWNLOAD-MANAGER.md` currently claims *"Pause / resume — **Yes**, with a safety check before
resuming"* and *"Resume after a crash or restart — **Yes** — partial segments are kept and
verified"*. **Both are false.** That file needs correcting whether or not the code is fixed; it is
the exact failure mode `docs/ROADMAP.md` opens by warning about.

### D-2 — Engine state is in-memory only *(critical)*

`DownloadQueue` holds `records`, `pairs`, `contexts`, `hints`, `streams` in `Map`s. Nothing is
written to SQLite and nothing is read at startup. Quit the browser and every managed download —
queued, paused, scheduled for 2 a.m., or 90% complete — is gone from the list, with the partial
files orphaned on disk. Requirements 13 and 14 are simply not implemented.

### D-3 — Protocol dispatch is still extension-based

`isStreamUrl` matches `.m3u8`/`.m3u` on the path. Real CDNs serve HLS from extension-less paths.
The recent `isStream` flag routes around this **when the caller knows**, but a download reaching the
queue by any other route still guesses from the URL. This violates requirement 20's spirit: the
classifier is MIME-first, the dispatcher is not.

### D-4 — DASH goes down the HLS path and produces a confusing refusal

`classifyMedia` marks `.mpd` / `application/dash+xml` as `kind: 'stream'`, `toDownloadable` offers
it as "DASH stream · joined on download", and the engine sends it to `planStream`, which parses XML
as an M3U8, finds no `#EXTINF` lines, and reports *"This stream lists no segments."* The button
should not have been offered, or DASH should be parsed.

### D-5 — No destination chooser on the engine path

`askWhereToSaveDownloads` is honoured by Chromium's downloader, and `shouldTakeOver` explicitly
refuses to accelerate when it is on — *"the save dialog is on, and the engine has no equivalent"*.
So turning on "ask every time" silently disables the entire accelerator. Requirement 22 asks for a
destination in the dialog; supplying one removes this whole exclusion.

### D-6 — Retry does not discriminate

`fail()` retries any error up to four times with backoff. A 404, a 403, a DRM refusal and a dropped
socket are treated identically. Requirement 12 asks for *intelligent* retry: non-retryable statuses
should fail immediately with the reason.

### D-7 — Media identity is the URL, so a re-issued manifest is a new download

`MediaLedger` dedupes by URL within a generation. A player that re-requests its manifest with a
fresh token produces a *different* URL and therefore a second row for the same video.
Requirement 12's "duplicate detection" needs a stable identity — manifest URL normalised of
token-ish query parameters, plus frame/page context.

### D-8 — No cap on playlist or segment counts

`parseMedia` will happily return a million segments from a hostile playlist, and `StreamDownload`
will queue all of them. Requirement 13's threat model calls for limits; there are none.

### D-9 — `safeFilename` is good but the destination is not confined

`safeFilename` strips path separators, control characters, leading dots, and Windows reserved names,
and caps at 180 characters — that part is solid. But nothing asserts the *resolved* final path is
inside the chosen directory. A defence-in-depth `resolve()`-and-compare belongs there, since
`Content-Disposition` is attacker-controlled.

---

# Part 4 — Exact files to modify and create

## Modify

| File | Change |
|---|---|
| `src/main/downloads/engine/DownloadQueue.ts` | Real resume (call `SegmentedDownload.resume`); persistence hooks; restore on boot; retryability check; stream/file dispatch by classification not URL |
| `src/main/downloads/engine/SegmentedDownload.ts` | Open destination `r+` when continuing; expose segment table for persistence |
| `src/main/downloads/engine/planning.ts` | `isRetryable(status)`; `confinedPath()`; keep `isStreamUrl` as last-resort fallback only |
| `src/main/downloads/engine/StreamDownload.ts` | Segment/playlist caps; per-segment retry; DASH dispatch |
| `src/main/media/mediaSniffing.ts` | Stable media identity for dedupe; carry `kind` through `toDownloadable` |
| `src/main/db/migrations/index.ts` | Migration v25: `engine_downloads` + `engine_download_segments` |
| `src/main/AppContext.ts` | Wire the new repository into `DownloadQueue`; restore at startup |
| `src/shared/types/downloadEngine.ts` | `protocol` field; persisted-shape schema |
| `src/shared/ipc/contracts.ts` | Destination-chooser channel; richer media-options payload |
| `src/main/ipc/handlers.ts` | Handlers for the above |
| `src/main/downloads/takeover.ts` | Drop the `askWhereToSave` exclusion once the engine has a chooser |
| `src/renderer/features/downloads/DownloadsCenter.tsx` | Open file / open folder / retry actions |
| `src/renderer/features/media/MediaPicker.tsx` | Destination row, audio-track row, per-quality size |
| `docs/DOWNLOAD-MANAGER.md` | **Correct the two false claims** |

## Create

| File | Purpose |
|---|---|
| `src/main/db/repositories/EngineDownloadRepository.ts` | Persist engine downloads + segments |
| `src/main/media/resourceClassifier.ts` | One protocol-first classifier: headers → `direct` / `hls` / `dash` / `protected` / `unknown`; pure, tested |
| `src/main/media/dash/mpdParser.ts` | MPD → representations |
| `src/main/media/dash/representations.ts` | Selection + segment planning (`SegmentTemplate`, `SegmentList`, `SegmentBase`) |
| `src/main/media/dash/mpdParser.test.ts` | Real MPD shapes |
| `src/main/media/mediaIdentity.ts` | Stable identity for dedupe; pure, tested |
| `src/main/downloads/engine/retryPolicy.ts` | Which failures are worth retrying; pure, tested |
| `src/main/downloads/engine/limits.ts` | Segment/playlist/size caps; pure, tested |
| `src/main/downloads/engine/paths.ts` | Destination confinement; pure, tested |
| `docs/testing/download-manager.md` | Manual script covering the lot |

**Not created:** a `/downloader`, `/manager`, `/browser`, `/streaming` tree as sketched in the brief.
That structure already exists here under different names (`downloads/engine`, `media/`,
`shield/NetworkPolicy` + `SessionRegistry`), and duplicating it would leave two of everything. The
one genuinely new directory is `media/dash/`, mirroring the HLS code that already lives in
`media/hlsPlaylist.ts`.

---

# Part 5 — Sequenced plan

Each step ends green on typecheck, lint and the full suite before the next begins.

| Step | Work | Risk |
|---|---|---|
| 1 | **Fix D-1.** Real pause/resume: continue into the same file via `SegmentedDownload.resume`, guarded by `resumeIsSafe`. Correct `docs/DOWNLOAD-MANAGER.md`. | Low, high value |
| 2 | **Persistence.** Migration v25, `EngineDownloadRepository`, restore-on-boot reconciling anything left `downloading` to `paused`. | Medium — migrations are irreversible |
| 3 | **`resourceClassifier.ts`.** Protocol from headers; `isStreamUrl` demoted to fallback. Fixes D-3. | Low |
| 4 | **Retry policy + limits + path confinement.** D-6, D-8, D-9. All pure, all tested. | Low |
| 5 | **Media identity.** D-7. | Low |
| 6 | **DASH.** Parser, representation selection, segment planning; reuse `StreamDownload`'s ordered writer. D-4. | Medium — MPD has many shapes |
| 7 | **UI.** Destination chooser, open file/folder, retry, richer picker. Then drop the `askWhereToSave` takeover exclusion (D-5). | Low |
| 8 | **Integration tests + manual script.** Local HTTP server fixtures for redirects, ranges, no-range fallback, HLS, DASH, hostile inputs. | Low |

---

# Part 6 — What will not be built, and why

- **No DRM circumvention.** Widevine/PlayReady/FairPlay and `#EXT-X-KEY` with a real method are
  recognised **in order to be refused with a reason**. This is already the codebase's stated line and
  it does not move.
- **No fabricated YouTube URLs.** Where the player response lists formats with no address —
  server-driven delivery, measured at 30/30 on a real watch page — the honest report is *"media
  detected, no downloadable representation available"*. Slash will not run YouTube's signature or
  negotiation code to manufacture one. That is a documented product decision in `CLAUDE.md`; if you
  want it changed, say so and it becomes an explicit feature rather than a quiet capability.
- **No site-specific hacks** beyond the one that already exists (`PageMediaExtractor`, hostname-gated
  and user-initiated). Everything else is protocol-driven.
- **No second webRequest listener.** Electron allows one per event per session and both are spoken
  for; anything new hangs off the existing ones.
- **No `Sec-Fetch-*` headers, and no path-bearing cross-origin `Referer`.** Both are rejected by
  Chromium — measured, and recorded in `CLAUDE.md`.

---

# Part 7 — Decisions I need from you

1. **Migration v25 is one-way.** Adding two tables is safe, but this repo has 24 migrations and a
   failed one takes the database — and therefore the browser — down with it. Confirm you want engine
   persistence now rather than after the other fixes land.
2. **DASH scope.** Full MPD support is large. I propose: on-demand profile, `SegmentTemplate` and
   `SegmentList`, video+audio representations joined by the existing muxer; **live and multi-period
   refused with a reason**, exactly as live HLS already is. Tell me if you want more.
3. **Destination chooser.** Adding one to the engine means a native dialog from main. It removes the
   `askWhereToSave` exclusion that currently disables acceleration entirely for anyone who turns that
   setting on — I think it is worth it, but it changes takeover behaviour for existing users.
4. **Retry semantics.** I intend to fail immediately on 400/401/403/404/410 and on any refusal
   naming DRM, and to keep the backoff only for timeouts, 5xx, 429 (honouring `Retry-After`) and
   dropped sockets. Say if you would rather keep retrying everything.

I have not changed any code for this audit. Say which step to start on — or "all of it, in order" —
and I will work through Part 5, reporting files changed, tests run and remaining limitations at each
step.
