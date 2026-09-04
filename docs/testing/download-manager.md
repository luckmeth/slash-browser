# Download manager — manual checks

Automated coverage first, because most of this is verified without a human:

```bash
npm run typecheck && npx eslint . && npx vitest run   # 59 files, 1037 tests
SLASH_RESUME_PROBE=1   npm run dev   # 33 checks: pause/resume, retry, restart
SLASH_STREAM_PROBE=1   npm run dev   # HLS assembly, video+audio join, DASH
SLASH_DOWNLOAD_PROBE=1 npm run dev   # segmented vs single-stream checksums
SLASH_MEDIA_ACCESS_PROBE=1 npm run dev  # real sites: headers, referrer, redirects
```

The probes launch the real browser, run against real servers, and read the finished files back.
`SLASH_RESUME_PROBE` ends with either `all checks passed` or a count of failures.

What follows is what a person still has to look at.

---

## A — Pause and resume actually continue

1. Start a large download (a Linux ISO, or any file over ~500 MB).
2. Wait until it is around half done, then **Pause**.
3. Note the byte count and the filename.
4. **Resume**.

**Expect:** the byte count continues from where it stopped. The filename does not change.
**Fail:** the count returns to zero, or a second file appears with ` (1)` in its name.

This was broken until recently — resume set the state back to `queued`, the queue chose a new path
because the partial file collided with itself, and the whole file downloaded again. The state went
`paused` then `completed` and the file was correct, so nothing in the UI could show it.

## B — Surviving a restart

1. Start a large download and let it reach roughly a third.
2. **Quit Slash entirely** while it is transferring.
3. Open Slash again and look at the Downloads Center.

**Expect:** the download is still listed, marked **paused**, with the bytes it already had, and a
note saying it was interrupted. Nothing is transferring.
**Expect on Resume:** it continues from those bytes rather than starting again.
**Fail:** the list is empty, or the download resumes by itself, or it restarts from zero.

Nothing resumes automatically on purpose. Quietly restarting several large transfers the moment
somebody opens their browser spends their bandwidth without asking.

## C — Choosing where a file goes

1. Settings → turn **Ask where to save each file** on.
2. Right-click a link to a file over 4 MB → **Download with Slash (managed)**.

**Expect:** a save dialog. Choosing a location downloads there, **through the engine** — check the
Downloads Center shows a connection count, not Chromium's own download shelf.
**Expect on Cancel:** nothing downloads.
**Fail:** no dialog, or the download appears in Chromium's list instead.

Until this change, turning that setting on silently disabled the whole accelerator.

3. On a video page, open the download chip → picker. **Expect:** a "Save to" row showing the folder,
   with a **Change** button that opens a folder chooser.

## D — Quality selection

1. Open a film on a site whose player offers several qualities (HLS).
2. Downloads panel → **Find media**.

**Expect:** one row **per quality** — "1080p · joined on download", "720p …" — each with its
bitrate. Not a single row called "HLS stream".
3. Download the 720p row. **Expect:** the finished file is 720p, not the largest variant.

For MPEG-DASH the same applies; each row is one representation.

## E — DASH, and what it refuses

1. Play a video on a site using MPEG-DASH (`.mpd`). **Expect:** qualities listed, and a download
   that produces one file **with sound** — video and audio are separate representations and are
   joined by ffmpeg.
2. Open a **live** DASH stream. **Expect:** a refusal that says *"Live MPEG-DASH streams are not
   currently supported"*, not an empty list.
3. Open something DRM-protected (Netflix, Disney+). **Expect:** a sentence saying the content is
   encrypted. **Fail:** any attempt to download it.

## F — Failures behave sensibly

1. Point a download at a URL that returns 404 (edit one in the Downloads panel, or use a dead link).
   **Expect:** it fails **immediately**, once, saying the server refused it.
   **Fail:** four attempts over a minute.
2. Start a download, then disconnect the network for ten seconds.
   **Expect:** it retries with a growing wait, and continues when the network returns.
3. Cancel a download while it is waiting to retry. **Expect:** it stays cancelled.
   **Fail:** it starts again when the timer fires.

## G — Nothing else regressed

1. An ordinary small download from a link still goes through Chromium and appears in the downloads
   panel as before.
2. A download from a host that redirects (a GitHub release asset) completes.
3. YouTube: the picker either lists qualities that download and play, **or** explains that this
   video's formats carry no address. Both are passes. An empty list with no explanation is a fail.

---

## Known limits, stated rather than discovered

- **Streams cannot be paused.** There is no byte offset to return to, only a position in a segment
  list. Pause is refused with that reason rather than offering a Resume that would restart.
- **Resume needs a validator.** A server offering neither `ETag` nor `Last-Modified` cannot prove
  the file is unchanged, so the download starts again rather than risk splicing two versions.
- **Live streams and multi-period DASH are refused**, by name.
- **Encrypted streams are refused**, by name. That is a line, not a gap.
- **Private-window downloads are not written to the database**, so they do not survive a restart.
  A row describing one would outlive the window that promised to leave no trace.

## Speed: dynamic segmentation

```bash
env -u ELECTRON_RUN_AS_NODE SLASH_SEGMENT_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview
```

Runs the real `SegmentedDownload` against a real range server that throttles
**one** connection — the request starting at byte 0 — to 2 MB/s and serves
everything else flat out. That is the case a static split handles worst, and the
only one work-stealing exists for.

Nine checks. The two that matter most:

- **`checksum`** reads the finished file back off the disk and compares SHA-256
  against the bytes the server holds. Segments hand each other ranges mid-flight,
  and a bad hand-off produces a *complete* file that is wrong in the middle —
  nothing else in the run would notice. `first-mismatch` names the byte offset
  when it fails, because "the checksums differ" is not something you can debug.
- **`faster-than-static`** compares elapsed time against
  `(TOTAL_BYTES / CONNECTIONS) / SLOW_BYTES_PER_SECOND` — what the slow
  connection alone would have taken under a static split. That floor is
  arithmetic from the fixture's own configuration, not a recorded previous run,
  so it cannot drift and needs no A/B.

Last measured: **1.19 s against a 2.00 s floor**, 15 segments from 8 initial,
the throttled connection relieved of 4.00 MB down to 2.13 MB.

Then re-run `SLASH_RESUME_PROBE` as a regression: resume shares the worker pool,
and a resumed transfer that was work-stolen before it was paused comes back with
more segments than the connection limit.

## Auto-hidden chrome (needs a real cursor)

```bash
env -u ELECTRON_RUN_AS_NODE SLASH_AUTOHIDE_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview
```

The probe prints `PARK <x> <y>` and `AIM <x> <y>` and then waits. Drive the
**system** cursor from another shell — `sendInputEvent` is no use here, because
it injects below the layer that was eating the event:

```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(<parkX>, <parkY>)
Start-Sleep -Seconds 9
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(<aimX>, <aimY>)
Start-Sleep -Seconds 3
```

Four checks, and the first two exist so the last cannot pass vacuously:
`cursor-parked` (the pointer starts clear of the top edge — a run beginning with
the cursor already there reveals on contact and proves nothing), `chrome-hides`
(the rows really did collapse), `cursor-reached-the-top`, then `chrome-returns`.

Against the pre-fix code this reports `chrome-hides: PASS` and
`chrome-returns: FAIL`, which is the bug.

## The download-manager features

```bash
env -u ELECTRON_RUN_AS_NODE SLASH_IDM_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview
```

Eight checks against a real range server, reading the files back off the disk:
batch expansion and the four downloads it names, the `Video/` folder being
**created** (nothing had ever made one — the default downloads folder always
existed, which is why this failed with ENOENT the first time), the contents
being byte-for-byte correct, nothing left unsorted in the root, a paused queue
holding its own download while another queue keeps running, and unpausing
releasing exactly what was held.

## What YouTube actually offers

```bash
env -u ELECTRON_RUN_AS_NODE SLASH_YT_FORMAT_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview
# or point it somewhere else:
SLASH_YT_URL=https://www.youtube.com/watch?v=... SLASH_YT_FORMAT_PROBE=1 ...
```

Counts every format the page lists, split by whether it carries a plain `url`, a
`signatureCipher`, or **neither** — then reports what the picker would make of
it and what the network sniffer caught. Run this before treating "only one
quality" as a bug: on a measured watch page it was **30 formats, 0 with an
address of any kind**, which is a fact about the page and not about the reader.

## The external downloader

```bash
# The integration, against a fake that speaks yt-dlp's protocol — no network,
# no real binary. Uses a .cmd shim on purpose: that is how scoop and npm
# install yt-dlp, and Node will not spawn one directly.
env -u ELECTRON_RUN_AS_NODE SLASH_EXTERNAL_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview

# The managed install, for real, against the official releases. Downloads
# ~18 MB, verifies the published SHA-512, runs the binary, and lists a live
# page. This one cannot be faked usefully.
env -u ELECTRON_RUN_AS_NODE SLASH_INSTALL_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview
```

Last measured: `Installed yt-dlp 2026.08.19. Checksum verified.` · 17,840,399 bytes ·
`9 rows — MKV 2160p | MKV 1440p | MP4 1080p | MP4 720p | MP4 480p | MP4 360p |
MP4 240p | MP4 144p | Audio only`.

## Tabs and session survival

```bash
env -u ELECTRON_RUN_AS_NODE SLASH_SESSION_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview
```

Opens 25 tabs, then closes four at a time and re-checks the strip at every
width — the sweep passes through `scrollWidth === clientWidth` exactly, which is
where the old 16px mispredict clipped tabs into unreachability. Then waits for
the debounced autosave and asks what a restart would restore, **without
quitting**, because that is what a force-kill leaves behind.

Last measured: sweep `74:3447/1440 … 30:1440/1440`, never clipped, never a
negative offset, every close reduced the count, and `30 recorded against 30
open` in a snapshot 5 seconds old.

## Settings switches

```bash
env -u ELECTRON_RUN_AS_NODE SLASH_TOGGLES_PROBE=1 SLASH_PROBE_EXIT=1 npx electron-vite preview
```

Clicks the real switches on three categories and compares `settings.getAll()`
either side of every click. Counted **per click**, not by how many keys moved —
several switches legitimately write to the same key (the toolbar-button toggles
all edit `hiddenToolbarButtons`), so "four clicks, four keys" is the wrong
question and "did each click change anything" is the right one.

Against the pre-fix build this reports one setting changing and the previous one
reverting, which is the `SettingsSchema.partial()` bug.
