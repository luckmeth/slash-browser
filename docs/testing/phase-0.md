# Phase 0 — foundation & spikes: test script

Phase 0's deliverable is not a feature. It is proof that the two architectural bets everything else
depends on actually hold, plus the foundation they sit on. Re-run this script at the end of every
later phase as a regression check.

## Automated

```bash
npm run typecheck
```

Both tsconfig projects must pass. Sanity check that it is really compiling something — `noEmit` on a
`composite` project has been known to no-op silently:

```bash
npx tsc -p tsconfig.node.json --listFilesOnly | grep -c "/src/"
```

Expect a non-zero count (21 at time of writing).

```bash
npm test
```

Expect `ViewLayoutManager` green, including the clamp cases — Chromium rejects negative view bounds,
so a window shorter than the chrome band must degrade to a zero-height page rect.

## Spike A — transparent overlay above page content

The question: can a `WebContentsView` composite *above* live web content with real transparency? If
not, the command bar, dialogs and permission prompts of Phases 4–7 have nowhere to render.

`webContents.capturePage()` **cannot answer this** — it captures one view's own surface and would
return a perfect overlay image even if the overlay were rendering behind the page. The capture must
come from the OS compositor:

```bash
ADAPTIVE_SPIKE_CAPTURE=/tmp/spike.png npm run dev
```

The app shows the overlay, captures its own window via `desktopCapturer`, writes the PNG and quits.

**Pass criteria** — open the PNG and confirm all three:

1. The spike card is fully legible above the page.
2. The example.com heading, body text and "Learn more" link are **visible through the scrim**. If the
   page is not showing through, the view is painting an opaque sheet and transparency has failed.
3. The chrome band is drawn at the top with the page inset below it.

**Result 2026-08-14: PASS**, in both `npm run dev` and the packaged NSIS build.

Also printed by the same run:

```
security probe: PASS — page view has no browser/require/process/ipcRenderer
```

This is evaluated *inside the page*, not read from our configuration — the configuration is exactly
what could be wrong. A FAIL here is a release blocker.

## Spike B — SQLite from the running app

The question: does the native module load against the Electron ABI, and does it survive asar
packaging? A build that succeeds proves nothing; only the running app does.

Dev is covered by the run above. The packaged build is the one that matters:

```bash
npm run package
ADAPTIVE_SPIKE_CAPTURE=/tmp/spike-packaged.png "release/win-unpacked/Adaptive Browser.exe"
```

**Pass criteria** — in the captured card:

| Field | Expected |
|---|---|
| SQLite | 3.53.4 |
| Schema version | v1 |
| WAL | enabled |
| Foreign keys | enabled |
| Write/read round trip | PASS |
| Path | under `AppData\Roaming\adaptive-browser` |

**Result 2026-08-14: PASS.**

Confirm the binding was actually unpacked rather than trapped inside the archive — a `.node` inside
`app.asar` cannot be `dlopen`'d:

```bash
ls release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/
```

Expect **only** `win32-x64.node`. The other seven platform prebuilds are excluded in
`electron-builder.yml` (15 MB of dead weight). If you add a platform target, update that exclude list
or the new platform ships without its binding.

## Manual smoke test

```bash
npm run dev
```

1. Window opens, chrome band at top, example.com below it.
2. Click **Show diagnostics** — overlay appears over the page; all Spike B rows are populated.
3. Click **Close** — overlay disappears and the page is interactive again. This matters: overlay hit
   testing is rectangular, not per-pixel, so a full-window overlay that fails to detach leaves the
   page permanently unclickable.
4. Resize the window — chrome, page and overlay all track the new bounds.
5. Open devtools on the page view and run `window.browser` → `undefined`.

## Known gaps carried into Phase 1

- The default Electron menu bar (File/Edit/View/Window) is still present; a browser should own its
  own menu.
- CSP includes `'unsafe-inline'` for scripts because Vite's dev HMR preamble requires it. The
  production build emits no inline scripts, so this should tighten to a nonce.
- A single hard-coded page view stands in for `TabManager`.
