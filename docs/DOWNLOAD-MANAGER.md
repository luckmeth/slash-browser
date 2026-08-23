# The download manager, measured against IDM

Slash has a real download manager, not a download list. This is what it does, what it does not, and
which gaps are decisions rather than omissions.

## What is built

| IDM feature | Slash | Where |
|---|---|---|
| Multi-connection accelerated downloads | **Yes** — 1–8 connections per file, configurable | `SegmentedDownload`, `planConnections` |
| Takes over downloads from the browser | **Yes**, over 4 MB | `takeover.ts`, `DownloadManager.attachToSession` |
| Pause / resume | **Yes**, with a safety check before resuming | `resumeIsSafe` |
| Resume after a crash or restart | **Yes** — partial segments are kept and verified | `DownloadRepository`, `resumeIsSafe` |
| Automatic retry with backoff | **Yes** | `retryDelayMs` |
| Speed limiter | **Yes**, across all downloads | `downloadBandwidthLimit` |
| Queue with priorities | **Yes** — high / normal / low, plus "start now" | `DownloadQueue.setPriority` |
| Scheduler ("download later") | **Yes** — `startAfter`, an epoch time the queue honours | `DownloadQueue` |
| Categories by file type | **Yes** | `categorise` |
| Video grabber over the player | **Yes** — a chip over the page, then a quality picker | `MediaOfferChip`, `MediaPicker` |
| Batch "download all links" | **Yes**, excluding flagged links | `GuardianPanel` |
| Checks a link before you click it | **Yes**, and IDM has no equivalent | `linkAnalysis.ts` |
| Reassembles HLS streams into one file | **Yes** | `hlsPlaylist.ts`, `StreamDownload` |
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

## What is not built, and why

**DASH (`.mpd`) manifests.** HLS covers most of the web; DASH is the same idea in XML and is the
obvious next step. Refused with an explanation for now rather than half-done.

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
