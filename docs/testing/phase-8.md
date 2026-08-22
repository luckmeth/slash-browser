# Phase 8 — the gap-list features: test script

Run `phase-0.md` through `phase-7.md` first as regression checks.

Twelve features, built to close the gap between Slash and what people expect a browser to do. Each
section states the property worth checking, not just the happy path.

---

## 1. Custom keyboard shortcuts

Settings → Browsing → Keyboard shortcuts.

- Click a shortcut, press a combination. It rebinds immediately — the menu is rebuilt, not restarted.
- **Press Escape while recording.** It cancels and binds nothing. Escape must always mean "stop", or
  somebody binds it and can no longer back out of the next screen that traps them.
- **Try a bare letter.** Refused, with the reason: it would fire while typing into a page.
- **Bind two commands to the same keys.** Allowed, but the row says which other command it now
  shares with. Electron does not complain about duplicates — it fires whichever menu item it reaches
  first and the other silently stops working, so detecting it is the only way anyone finds out.
- **Reset all**, then confirm the count of changed shortcuts goes to zero.
- Restart. Bindings survive; a binding equal to the default is pruned on write, so changing a
  default later still reaches the user.

## 2. Multi-window session restore

- Open three windows with different tabs. Quit by closing them one at a time.
- Relaunch: **three windows**, each with its own tabs, in order.

The bug this fixes was silent — every page came back, so nothing looked broken. The arrangement had
simply collapsed into one window. `retainClosingWindow` also used to *replace* rather than
accumulate, so a three-window quit kept only whichever window closed last.

- Check a **restore point** too (Settings → Restore points → Restore). It reports how many windows it
  opened.
- A snapshot taken while a **private window** was open leaves a gap in the indices; restoring must
  not produce an empty window for it.

## 3. Picture-in-picture

- View → **Picture in Picture** (Alt+P) on a page with a video. Largest *playing* video wins — a page
  with a hero background loop, an advert and the real video must pick the real one.
- Press it again: the picture-in-picture window closes.
- **On a page with no video**, a notice appears saying so. A control that silently does nothing is
  indistinguishable from a broken one.
- Right-click a video → **Picture in picture**. This entry appears only on a video, so it never has
  to explain itself.

## 4. Hardware media keys

Settings → Browsing → Media keys.

- Play a video. Press the physical pause key → it pauses.
- **Play something in another application** (Spotify, a music player), leave Slash unfocused, press
  pause. **Slash must not take it.** Keys are registered on focus and released on blur.
- Turn on "Even when Slash is in the background" and repeat: now Slash *does* take it. That is the
  documented cost of that switch.
- Turn media keys off entirely — the keys are released **immediately**, not at next launch.
- With two tabs playing, pause acts on the one that started most recently. With one playing and a
  different one in front, pause acts on the **playing** one.

## 5. Print preview

Ctrl+P.

- The sheet on the left is a real render, not an approximation — the same `printToPDF` the Save as
  PDF button uses. Change scale or orientation and watch it re-render.
- **Page ranges:** `1-3, 5`, `8-`, `-3`. An unreadable range prints everything rather than guessing.
- Overlapping ranges (`1-3, 2-5`) are merged. Chromium honours an overlap by printing those pages
  twice, which is never what the person typing it meant.
- **Page count** is read out of the generated PDF and shown; when it cannot be determined the "of N"
  is omitted rather than guessed.
- Save as PDF, then print — the two must produce the same document.

## 6. Accessibility

- **Tab through the whole toolbar with the keyboard.** Every control shows a focus ring. There were
  none at all before this; icon-only buttons were invisible to keyboard users.
- Turn on increased contrast in Windows settings. Glass panels become opaque; nothing moves.
- Turn on reduced motion. Animations stop.
- With a screen reader running, arrow through omnibox suggestions. The suggestion count is
  announced from the **chrome document**, because the list lives in the overlay — a separate
  `WebContentsView` with its own document, which an `aria-controls` id reference cannot cross. The
  old code declared that relationship and it silently resolved to nothing.

**Not verified:** no screen reader has been run against this end to end. It is the largest remaining
unknown in the product.

## 7. Sync

Settings → Privacy & security → Sync. See `../sync.md` for the protocol.

- With no endpoint set, **nothing is ever contacted**. Confirm with a network capture.
- Set an endpoint, enter a passphrase, sync. Inspect what the server received: **ciphertext only** —
  no URL, no title. The reading list's ids are URLs and that is stated in `sync.md`; bookmarks travel
  by random guid.
- **Second device, same passphrase** → the same data. The salt and verifier come back from the
  server so both derive the same key.
- **Second device, wrong passphrase** → refused with "does not match". Without the verifier a typo
  looks exactly like an empty account, and the user starts a second, permanently diverged history.
- **Delete a bookmark on one device**, sync both. It must stay deleted. Without tombstones it comes
  back the moment the other device syncs.
- Edit the same bookmark on both, sync. Newer wins. Same-millisecond ties resolve to the deletion on
  *both* devices — which one wins matters less than all of them agreeing.
- **Stop the server mid-sync.** The browser keeps browsing; the reason appears in Settings.

## 8. Updates

Settings → About Slash → Updates.

- On this unsigned build the **Install and restart** button is present and **disabled**, with the
  reason beside it. `isSignedBuild()` asks Windows whether the running binary carries a valid
  Authenticode signature — it does not read a flag set at build time, because what matters is the
  binary on this machine right now.
- `npm run dev` always reports unsigned, so a dev run can never install over itself.
- After buying a certificate and setting `CSC_LINK`/`CSC_KEY_PASSWORD`, the button becomes live with
  **no code change**. That is the whole point of the check.

## 9. Page translation

Requires an AI provider **and** "Let AI read page content" — translating means sending the page's
text to that provider, so it uses the same consent as everything else that does.

- With either switched off, the **Translate** button does not appear in the reader.
- Open an article in reader mode → Translate. The title and every paragraph are translated.
- **Show original** toggles back instantly — the original was never discarded.
- A notice states that the text was sent to the provider and that machine translation gets things
  wrong.
- **Force a bad reply** (a model that ignores the markers): nothing is shown, and the reason says so.
  A partial or shifted translation reads exactly like a correct one, and the reader has no way to
  tell — so refusing beats guessing.

## 10. Saved addresses

See `autofill.md` — it has its own script.

## 11. Profiles

Settings → Privacy & security → Profiles.

- Create a profile, switch to it. Slash **restarts**: `app.setPath('userData')` is only honoured
  before anything opens a file, and by the time somebody clicks Switch the database and every
  session partition are already open. Chrome does the same thing for the same reason.
- The new profile has **nothing** — no history, no bookmarks, no passwords, no sign-ins. That is
  what distinguishes it from a workspace.
- Switch back. The first profile is exactly as it was, tabs included.
- **The default profile's directory must not move.** Confirm `%APPDATA%/Slash` is still the default
  profile's folder — an upgrade that relocated it would look precisely like all your data vanishing.
- Other profiles are **siblings** (`Slash-profile-work`), never children. Nested, the default
  profile's "delete all data" would take every other profile with it.
- **Deleting the profile you are using** is refused — it would pull the database out from under
  every open tab.
- Launch with `--profile=nonexistent`. Falls back to the default rather than creating one: a new
  empty profile looks exactly like all your data having gone.

## 12. Notices

The toast surface several of the above depend on.

- It appears over the page, bottom centre, and dismisses itself after a few seconds.
- **The page underneath stays clickable** while it is up. An overlay swallows every click inside its
  own bounds, so it is sized to a strip and is deliberately not modal.
- It carries `role="status"` so a screen reader announces it.

---

## Gates

```
npm run typecheck   # clean
npm test            # 673 passing
npm run lint        # clean
npm run package     # installer builds
```
