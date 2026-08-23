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

## What is not built, and why

**Joining separate video and audio into one file.** High-resolution video on YouTube and similar
sites is delivered as two streams. IDM combines them; Slash downloads each on its own and says so on
the row. Combining means shipping a muxer — ffmpeg is around 80 MB against a 155 MB installer, and
the alternative of downloading it on first use turns a local feature into an outbound request to a
third party, which is the thing `resources/models/` exists not to do. **This is the one real
capability gap, and it is a size decision rather than a technical one.** If it is worth 80 MB, it is
a day's work.

**Reassembling HLS/DASH segments.** Related but separate: a stream of thousands of segments can be
concatenated without re-encoding for some formats and not others. Currently refused with an
explanation rather than half-done.

**Formats behind a signed address.** Some sites build media URLs by running their own signature code
at playback time. Slash does not execute that to obtain a download address; the picker says so and
counts how many were skipped, rather than reporting "nothing found".

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
