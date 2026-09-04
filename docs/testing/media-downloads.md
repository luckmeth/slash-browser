# Manual test — video detection and download

What this covers: `MediaSniffer` (`src/main/media/`), the merged `guardian:scanMedia`, the toolbar
video button, and the honest refusals.

The automated tests cover the classifier and the per-tab ledger (52 cases). What they cannot cover
is whether real sites are actually seen, which is the only question that matters here.

## What this feature is, and is not

It is a network observer. It offers **complete files** it saw the page fetch. It does **not**
reassemble HLS/DASH segments, and it does **not** touch DRM-protected streams — those are
recognised so the panel can say why there is nothing to download.

If a check below says "no button, with a reason", that is a pass. A button that downloads four
seconds of unplayable video is the failure.

## 0 — It must not cost anything on ordinary pages

The listener runs in the main process for every response it is registered for, so this check comes
first. A feature that makes browsing feel heavy is not worth having.

1. Settings → Browsing → **Video downloads** → confirm both switches are on.
2. Open three or four heavy, image-and-script pages — a news front page, a shopping site.
3. **Expect:** scrolling and tab switching feel exactly as they did before. No stutter on load.
4. Turn **Find downloadable video and audio on pages** off and repeat.
5. **Expect:** no perceptible difference. If there *is* one, the filter or the callback has
   regressed — the listener is registered for `media`/`xhr`/`object` only, and switching it off
   removes it entirely rather than skipping its body.
6. Turn it back on.

## 1 — A plain progressive file

1. Open a page with a direct `<video src="…mp4">` — e.g. any `.mp4` link opened directly, or
   <https://test-videos.co.uk/bigbuckbunny/mp4-h264>.
2. **Expect:** within a second or two of playback starting, **a small panel appears in the top-right
   corner of the page** with the filename, the size and a Download button — and a video icon
   appears in the toolbar, right of the downloads button.
3. Click somewhere on the video *underneath* the panel. **Expect:** the click reaches the page. The
   panel is not modal, and a chip that made the player inert would be worse than no chip.
4. Press **Download** on the panel. **Expect:** the panel goes, and the file appears under
   *Managed downloads*. Open it — **it must play**.
5. Reload, then press the panel's **×**. **Expect:** it goes and does not come back for this page.
   Navigate elsewhere and back — **expect** it offers again. Dismissing one video is not a
   statement about every video.
3. Hover it. **Expect:** "Download video (N found on this page)".
4. Click it. **Expect:** the downloads panel opens and the media list is **already populated** — no
   second button to press.
5. Each row reads `<filename> · <size>`. **Expect:** the size is plausible for the video, and the
   largest file is first.
6. Press "Download this". **Expect:** it appears under *Managed downloads* and completes. Open it —
   **it must play**.

## 2 — The advert must not outrank the feature

1. Play a video on a site that runs a pre-roll.
2. **Expect:** once the feature has started, the top row is the bigger file, not the pre-roll.

Ranking is by kind then size, so a short advert can only be first while it is the only thing seen.

## 3 — YouTube

The site this feature is judged on, and the one a network observer alone cannot serve: media
arrives as byte ranges of `videoplayback`, so watching responses sees fragments and never a file.
The page's own format list is read instead — on the user's click, not on load.

1. Open a YouTube video and let it play a moment.
2. **Expect:** the chip appears in the top-right of the page, reading the video title and
   *"Choose a quality"*.
3. Click **Download**. **Expect:** the picker opens, listing qualities with sizes.
4. **Expect** the entries that play on their own are at the top. Rows that are picture-only say
   **· no sound** on the row itself, not in a footnote.
5. Pick a complete one. **Expect:** it appears under *Managed downloads*, completes, and **plays
   with sound**.
6. **Expect** the saved file is named after the video and its quality — not `videoplayback`,
   which is what every YouTube URL is called and a name nobody ever finds again.
7. If the picker is empty, read what it says. Both outcomes are correct behaviour, not bugs:
   - *"signed addresses"* — this video's formats need the site's own signature code to build
     their URLs. Slash does not run it.
   - *"adaptive stream"* / *"encrypted"* — the older refusals, still correct.

**Must not:** offer a row that downloads to an unplayable file, or say "nothing found" when the
real reason is signed addresses.

## 3a — A stream, joined into one file

The case that used to be refused outright. Any site with an HLS player will do — a news site with
video, a sports replay, an embedded player that is not YouTube.

1. Play the video, then open the picker.
2. **Expect:** a row offering the stream, with **no size** — a playlist has no length of its own,
   and a number invented from the manifest would simply be wrong.
3. Save it. **Expect** the row shows *"Joining segment N of M"* while it works.
4. **Expect** the finished file is named `.ts` or `.mp4` — never `.m3u8`, which Windows opens in a
   text editor.
5. **Open it. It must play from beginning to end, with sound.** Skip to the middle and the end.
   Segments written out of order produce a file that plays for ten seconds and then corrupts, so
   checking only the start proves nothing.

## 3b — A live stream must be refused

1. Open any live broadcast with an HLS player and try to download it.
2. **Expect:** refused, saying it has no end to download.
3. **Must not:** start, and produce a file that stops at an arbitrary moment. Downloading something
   with no end is recording, which is a different feature.

## 3c — Video and audio joined

1. On a page offering resolutions above 720p, open the picker.
2. **Expect:** high-resolution rows read **· sound added**, not **· no sound**.
3. Save one. **Expect** the row shows *"Downloading video…"*, then *"Downloading audio…"*, then
   *"Joining video and audio…"*.
4. **Expect one file** in the downloads folder, not two.
5. **Play it. It must have picture and sound.** This is the whole feature.
6. Check the parts are gone — no `.video.part` or `.audio.part` left behind.

### If ffmpeg was not fetched

1. Move `resources/ffmpeg` aside and repackage.
2. **Expect:** rows read **· no sound** again, and picking one saves a single silent stream.
3. **Must not:** claim sound will be added and then not add it.

## 3d — Segmented delivery elsewhere

1. Open any YouTube video and let it play for ten seconds.
2. Open the downloads panel and press **Find media** if the button did not appear.
3. **Expect:** either nothing offered with the note *"delivered as an adaptive stream — thousands of
   short segments rather than one file"*, or the note about encryption.
4. **Must not:** list dozens of near-identical rows, or offer a `.m3u8`/`.mpd` URL as a download.

## 4 — DRM: the refusal

1. Open a Netflix, Disney+ or Prime Video title page and start playback (an account is needed).
2. Open the downloads panel and press **Find media**.
3. **Expect:** no downloadable rows, and the note naming encryption:
   *"Slash does not work around a service's technical protections."*
4. **Must not:** offer any row. If one appears, the classifier's protection hints have drifted and
   that is a release blocker, not a cosmetic bug.

## 4b — The panel must never steal the overlay

The chip and every dialog share one overlay view, so this is the failure mode to watch for.

1. With the panel showing over a video, press **Ctrl+K** (command palette).
2. **Expect:** the palette opens normally. The panel gives way.
3. Press Escape. **Expect:** the palette closes **and the panel comes back**.
4. Repeat with the reader (Ctrl+Shift+R) and the shortcut sheet.
5. **Must not:** the palette flickering, failing to open, or the panel winning.

## 4c — The panel follows the video, not the page

1. On YouTube, with the panel showing, click a suggested video.
2. **Expect:** the panel updates to the new file rather than continuing to offer the previous one.
   Showing the right chip for the wrong video is worse than no chip.

## 5 — The button belongs to one tab

1. Start a video in tab A. Confirm the button is there.
2. Ctrl+T, open a text page in tab B. **Expect:** no video button.
3. Switch back to A. **Expect:** the button is back.
4. In A, navigate to a text page. **Expect:** the button disappears.

## 6 — YouTube's next-video case (the race)

1. Play a video, confirm detection.
2. Click a suggested video in the sidebar — a same-document navigation.
3. **Expect:** the panel reflects the *new* video once it has fetched anything, and never shows an
   empty list in the gap. The previous video's entries persist only until the new one is seen.

## 7 — Blocking still works

`onBeforeRequest` belongs to Slash Shield and `onResponseStarted` to media detection. Registering a
second listener for one event silently replaces the first, so this check is not optional.

1. With detection exercised (steps 1–3 above), open a page with obvious adverts.
2. **Expect:** Slash Shield still blocks — check the shield panel's count for the tab is non-zero.

## 8 — Background tabs stay quiet

1. Start a video in tab A, switch to tab B and stay there.
2. **Expect:** no video button appears in B while A keeps playing.

## 9 — Switching the panel off

1. Settings → Browsing → Video downloads → **Show a download button over the video** off.
2. Play a video. **Expect:** no floating panel, but the toolbar button still appears and the
   Downloads panel still finds the file.
3. Turn **Find downloadable video and audio on pages** off. **Expect:** the second switch greys out,
   and neither the panel nor the toolbar button appears.

## Regression

Re-run `docs/testing/adblocking.md` (shared `webRequest` surface) and
`docs/testing/phase-8.md`.
