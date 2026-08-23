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

## 1 — A plain progressive file

1. Open a page with a direct `<video src="…mp4">` — e.g. any `.mp4` link opened directly, or
   <https://test-videos.co.uk/bigbuckbunny/mp4-h264>.
2. **Expect:** within a second or two of playback starting, a video icon appears in the toolbar,
   right of the downloads button, in the accent colour.
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

## 3 — YouTube: the segmented case

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

## Regression

Re-run `docs/testing/adblocking.md` (shared `webRequest` surface) and
`docs/testing/phase-8.md`.
