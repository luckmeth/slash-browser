# The download manager, measured against IDM

Slash has a real download manager, not a download list. This is what it does, what it does not, and
which gaps are decisions rather than omissions.

## What is built

| IDM feature | Slash | Where |
|---|---|---|
| Multi-connection accelerated downloads | **Yes** — 1–8 connections per file, configurable | `SegmentedDownload`, `planConnections` |
| Takes over downloads from the browser | **Yes**, over 4 MB | `takeover.ts`, `DownloadManager.attachToSession` |
| Pause / resume | **Yes** — continues from the bytes on disk, with a validator check first | `DownloadQueue.beginResume`, `resumeIsSafe` |
| Resume after a crash or restart | **Yes** — written to SQLite, restored paused, continues from disk | `EngineDownloadRepository`, `DownloadQueue.restore` |
| Automatic retry with backoff | **Yes** — jittered, capped, cancellation-aware | `retryPolicy.ts` |
| Speed limiter | **Yes**, across all downloads | `downloadBandwidthLimit` |
| Queue with priorities | **Yes** — high / normal / low, plus "start now", reachable from the Downloads Center | `DownloadQueue.setPriority`, `DownloadsCenter.tsx` |
| Scheduler ("download later") | **Yes** — `startAfter`, an epoch time the queue honours | `DownloadQueue` |
| Categories by file type | **Yes** | `categorise` |
| Video grabber over the player | **Yes** — a chip over the page, then a quality picker | `MediaOfferChip`, `MediaPicker` |
| Batch "download all links" | **Yes**, excluding flagged links | `GuardianPanel` |
| Site grabber — crawl a site for its files | **Yes** — same-origin, depth-capped, honours robots.txt | `SiteGrabber`, `crawlPlan.ts` |
| Notices a download link you copied | **Yes**, off by default, only while focused | `ClipboardWatcher` |
| Checks a link before you click it | **Yes**, and IDM has no equivalent | `linkAnalysis.ts` |
| Reassembles HLS streams into one file | **Yes** | `hlsPlaylist.ts`, `StreamDownload` |
| Reassembles MPEG-DASH (VOD) into one file | **Yes** — SegmentTemplate, SegmentList, SegmentBase | `media/dash/mpdParser.ts` |
| Lists the qualities a stream offers | **Yes** — one row per variant, HLS and DASH | `readStreamVariants` |
| Chooses where each file goes | **Yes**, without falling back to Chromium | `chooseDownloadFolder`, `confinedPath` |
| Retries only what is worth retrying | **Yes** — 404 fails at once; 429 honours `Retry-After` | `retryPolicy.ts` |
| One row per video, not one per token | **Yes** | `mediaIdentity.ts` |
| Joins separate video and audio | **Yes**, bundled ffmpeg | `Muxer`, `DownloadQueue.enqueueJoined` |

## Streams and joining, which used to be the gap

**HLS streams are assembled.** A playlist is read, the best quality picked, and its segments
downloaded four at a time and written **strictly in order** — a video is its segments in sequence,
and one written out of turn corrupts everything after it. No re-encoding: the bytes go to disk as
they arrive. MPEG-TS concatenates directly; fragmented MP4 needs its `#EXT-X-MAP` initialisation
segment first, and a stream whose shape is not recognised is refused rather than guessed at, because
the failure there is a file that downloads perfectly and will not open.

**Live streams are refused on purpose.** A live playlist has no end, so downloading one means
choosing a moment to stop. That is recording — a different feature with different expectations, and
not something that should happen by pressing a button labelled Download.

**Separate video and audio are joined.** Every adaptive site above about 720p sends picture and
sound apart. One entry in the download list fetches both and joins them with the bundled ffmpeg, so
what lands in the folder is one file. The join is a **remux** — `-c copy`, nothing decoded or
re-encoded — so a two-hour film joins in seconds and is bit-identical to what was downloaded.

If the join fails, or ffmpeg is absent from the build, both parts are kept and the row says so. Two
files that play beat one error where a download should be.

## Surviving a restart

Engine downloads are written to SQLite — `engine_downloads` and `engine_download_segments`, added in
migration 24 — with enough to pick the transfer up again: the segment table, the validator the server
gave us, and the request context.

**Nothing resumes by itself.** A transfer that was running when Slash closed comes back **paused**,
because quietly restarting several large downloads the moment somebody opens their browser is a
decision to spend their bandwidth without asking. Queued and scheduled downloads come back as they
were, since those were already instructions to start.

**No credential is stored.** The request context is a session partition *name*, a referrer and a user
agent; cookies are asked of Chromium's own jar by partition when the download is picked up again. A
cookie copied into a database row is a live credential outliving the tab it came from. Downloads made
in a private window are not written at all.

## Pause and resume, and what it used to do

Pausing stops the transfer and keeps every byte already written. Resuming re-probes the server,
checks the file has not changed underneath — a strong `ETag`, or failing that `Last-Modified`, and
**no validator means no resume** — then fetches only the ranges still missing, into the same file.

Two things it deliberately does not do. It does not choose a new destination: `uniquePath` refuses to
overwrite an existing file, which is right the first time and wrong every time after, because the
file it collides with is the download's own partial one. And it does not truncate: continuing opens
the destination `r+` and writes at offsets.

This is worth stating because until recently none of it was true. `resume()` only set the state back
to `queued`; the queue then chose a *new* path (`film (1).mp4`), opened it with `'w'`, and downloaded
the whole file again. `SegmentedDownload.resume` existed, was correct, and was never called from
anywhere. Nothing in the UI could show the difference — the state went paused, then completed, and
the file was right. `SLASH_RESUME_PROBE` counts the bytes the server was asked for, which is the only
place the difference is visible.

## What is not built, and why

**Pausing a stream.** HLS and DASH downloads cannot be paused: there is no byte offset to come back
to, only a position in a list of segments and a part-written file that is not a valid video. Refused
with that reason rather than offering a Resume that would silently restart.

**Live and multi-period DASH.** A live manifest has no end, so saving one means choosing a moment to
stop — that is recording. Multi-period splices several presentations together and needs
concatenation rules this does not implement. Both are refused *by name*, not with an empty list.

**Encrypted HLS.** `#EXT-X-KEY` with any method but `NONE` is refused. The key is usually fetched
openly and unpicking it would be easy, which is exactly why the line is drawn at "we do not decrypt"
rather than at "we cannot".

**Formats behind a signed address.** Some sites build media URLs by running their own signature code
at playback time. Slash does not execute that to obtain a download address; the picker says so and
counts how many were skipped, rather than reporting "nothing found".

**Bypassing a site's URL signing.** Some sites build media addresses by running their own signature
code at playback time. Slash does not execute that to obtain a download address. The picker says so
and counts how many formats were skipped, rather than reporting "nothing found".

**DRM-protected video.** Not a gap. Widevine, PlayReady and FairPlay streams are recognised so they
can be refused with a reason. Neither IDM nor anything else downloads these, and Slash will not be
made to.

**Browser-integration for other browsers.** IDM installs an extension into Chrome and Firefox. Slash
accelerates downloads in Slash. Reaching into another browser is not something this one does.

## Why downloads under 4 MB are left alone

Taking a download over means cancelling Chromium's transfer and requesting the URL again. That is how
every download manager works, and it has two costs:

- It is a **second request**. For a static file that is nothing. For an endpoint that *does*
  something — generates a report, consumes a one-use token — it could do that thing twice.
- Chromium does not report the request **method**, so a download produced by submitting a form looks
  exactly like one produced by a link. Asked again as a GET it would fail, or return the wrong file.

Below 4 MB, splitting into connections saves less time than the extra round trip costs, so a takeover
would be pure risk for no gain — and small downloads are exactly where form results live. Above it,
the saving is the entire point. The threshold is `MIN_TAKEOVER_BYTES` and the reasoning is in
`takeover.ts`.

Downloads Slash declines to take are logged with the reason, so a takeover that silently did not
happen is distinguishable from one that was never wired up.

## The ffmpeg binary

Not in git. `npm run fetch:ffmpeg` downloads a **pinned** release, verifies its SHA-256 against a
checksum committed in the script, and writes `resources/ffmpeg/ffmpeg.exe`. It must be run once
before `npm run package` on a fresh clone.

Three deliberate choices there:

- **Pinned, not `latest`.** Otherwise the installer's contents change without a commit, which makes
  a build unreproducible and its signature close to meaningless.
- **Checksum enforced.** This is an executable that ships to users inside a signed installer. With no
  hash pinned the script prints what it got and *stops*, so somebody has to look before it can ship.
- **Bundled, not fetched on first use.** Same reasoning as `resources/models/`: downloading it when
  somebody presses a button turns a local feature into an outbound request to a third party, on a
  machine whose owner was told nothing leaves it unless they said so.

It costs about 88 MB, and it is the largest single thing in the installer.
