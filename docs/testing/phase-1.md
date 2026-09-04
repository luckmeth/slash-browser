# Phase 1 — core browser: test script

Run `docs/testing/phase-0.md` first; those checks are the regression suite for the
foundation this phase sits on.

## Automated

```bash
npm run typecheck && npm test && npm run lint
```

Expect 25 tests green across `ViewLayoutManager` and `UrlResolver`.

The `UrlResolver` suite is the one that matters most here, because omnibox behaviour is where a
browser feels wrong in ways that are hard to pin down. It pins several decisions that are easy to
regress:

| Input | Expected | Why |
|---|---|---|
| `example.com` | `https://example.com` | bare domain upgrades |
| `react` | search | a single word with no TLD must not become `https://react` — a wrong search is recoverable, a wrong navigation loses what was typed |
| `localhost:3000` | `http://localhost:3000` | digits after a colon are a port, not a scheme. This one shipped broken and was caught by the test |
| `javascript:alert(1)` | search | self-XSS defence — must never execute in the current document |
| `what is example.com used for` | search | whitespace means prose |

## UI capture

```bash
ADAPTIVE_UI_CAPTURE=/tmp/ui.png npm run dev
```

Writes two PNGs: the browser with three tabs on a live page, and a second with the History panel
open. The second is the important one — confirm **the page is inset beside the panel, not covered by
it**. If the page still spans the full width and the panel sits on top, `layout:setRightPanelWidth`
is not reaching `ViewLayoutManager` and the page is merely hidden underneath.

The same run prints `security probe: PASS` — a release blocker if it ever fails.

**Result 2026-08-14: PASS.**

## Manual checks

Run `npm run dev`.

### Tabs
1. `Ctrl+T` opens a tab; the new tab page lists most-visited and bookmarks.
2. Open ~20 tabs. Drag one to reorder. Drag a **pinned** tab — it must stay within the pinned block
   and refuse to drop among unpinned tabs.
3. Pin a tab (Tabs ▸ Pin/Unpin). It shrinks to an icon and moves to the front.
4. Middle-click a tab to close it. `Ctrl+Shift+T` brings it back **in its original position**.
5. `Ctrl+1`…`Ctrl+8` select by position; `Ctrl+9` selects the last tab.
6. Close the active tab in the middle of a run — focus lands on the tab that took its place, not at
   one end.
7. Play a video, then switch tabs. Audio continues (background views stay alive, only detached) and
   the tab shows a speaker icon that toggles mute.

### Navigation
8. Type `example.com` → navigates. Type `how to center a div` → searches.
9. Back/forward/reload/stop; buttons disable when the action is unavailable.
10. Click a `target="_blank"` link — it opens as a **tab**, not a detached popup window.
11. Click a `mailto:` link — a confirmation dialog appears naming the scheme and full URL, and
    nothing launches until you accept.

### Data
12. Visit a few sites, open History (`Ctrl+H`). Entries group under Today/Yesterday and visit counts
    increment on revisit rather than duplicating rows.
13. Search history; the query debounces rather than firing per keystroke.
14. `Ctrl+D` bookmarks the tab — the star fills. Press again to remove.
15. Download a file; watch progress, pause, resume, cancel. Quit mid-download and relaunch: the item
    reads **"Interrupted — cannot be resumed"**, which is the honest state — Electron cannot resume a
    transfer whose process has exited.
16. Download an `.exe` and click Open — a warning names the source host and states plainly that the
    check is extension-based and cannot tell whether that file is harmful.

### Settings and privacy
17. Change the search engine; the next omnibox query uses it.
18. Turn off **Record browsing history**, visit a site, reopen History — nothing new is written.
19. Settings shows Phase 4/5/7 features as disabled with the phase named, and states that this build
    denies every site permission request.

### Security
20. F12 opens devtools for the **page**, not the chrome UI. In that console:
    `window.browser`, `require`, `process`, `ipcRenderer` → all `undefined`.
21. The chrome view cannot be navigated: any attempt logs `blocked navigation of the chrome view`.

## Known gaps carried into Phase 2

- **All site permissions are denied.** `SessionHardening` ships a `denyAllPermissions` decider, so
  camera, microphone, location and notifications do not work. This is deliberate — Phase 4 replaces
  that one function with the real `PermissionManager`. It is stated in Settings so the behaviour is
  not mistaken for a bug.
- Profiles are designed for (`SessionRegistry` takes a partition) but not surfaced in the UI.
- Bookmark folders exist in the schema and render, but there is no UI to create or drag into one.
- Session restore on startup is not wired; `restoreTabsOnStartup` exists in settings but Phase 6 is
  what implements snapshots.
- History search is `LIKE`-based. Phase 5 replaces it with FTS5 + BM25 behind a `SearchProvider`
  interface, keeping the same call shape.
- The default Electron menu bar has been replaced with a real browser menu, but there is still no
  in-window custom title bar.
