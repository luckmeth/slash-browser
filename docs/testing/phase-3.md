# Phase 3 — adaptive performance: test script

Run `phase-0.md`, `phase-1.md` and `phase-2.md` first as regression checks.

## What this phase can and cannot do

Stated plainly, because the gap between the pitch and the mechanism matters here:

| State | What actually happens | Memory returned |
|---|---|---|
| ACTIVE / RECENT | View attached or detached but still "visible" to Chromium, so it is not throttled and switching back is instant | none |
| BACKGROUND | Detached; doing real work (audio, download) so it is never slept | none |
| IDLE | Idle past threshold, a candidate | none |
| FROZEN | Detached **and** marked hidden, so Chromium fires `visibilitychange`, throttles timers and stops rAF. Muted. Process alive | little — this buys CPU, not RAM |
| HIBERNATED | `WebContentsView` destroyed. URL, title, favicon, scroll and **navigation history** retained | **yes — this is the only state that frees memory** |

Electron has no freeze API, so FROZEN is built from what does exist. Be honest about it: the number
worth quoting is hibernation's, and only hibernation reports a **measured** figure — the real working
set read immediately before the renderer was destroyed. Everything projected is labelled *estimate*.

## Automated

```bash
npm run typecheck && npm test && npm run lint
```

Expect 57 tests. The `ResourcePolicyEngine` suite is the important one — it asserts that a tab idle
for hours is still **not** slept when any of these hold:

active tab · playing audio · active download · user-protected · unsaved form input ·
beforeunload observed · devtools open · internal page · already hibernated

Failing one of those means silently destroying someone's unsaved work, so they are tested
individually rather than as a group.

## Runtime verification

```bash
ADAPTIVE_PERF_CAPTURE=/tmp/perf.png npm run dev
```

Opens four tabs, then compresses the thresholds to seconds and lets the real engine run. Watch the
log:

```
tabs: hibernated tab-… (115396608 bytes)
tabs: hibernated tab-… (86376448 bytes)
tabs: hibernated tab-… (104898560 bytes)
  tab-…-1 state=ACTIVE      blockers=[active-tab]
  tab-…-2 state=HIBERNATED  blockers=[already-hibernated]
perf capture: total measured savings 306671616 bytes
```

**Pass criteria:** the three background tabs hibernate, the active tab does **not**, and the total is
a real sum of working sets.

**Result 2026-08-14: PASS — 292 MB freed across three tabs.**

## Manual checks

1. Open the panel (`Ctrl+Shift+P` or the clock icon). It is a panel you open — confirm no
   performance UI is permanently present in the chrome.
2. Play a YouTube video, switch away, set mode to **Aggressive**, wait past the threshold. It must
   **never** sleep. Expand its row: it says *"Playing audio or video"*.
3. Type into a form (any `<textarea>`), switch away, wait. It must never sleep — *"Has text typed
   into a form that would be lost"*. This is the content preload reporting a boolean; the text
   itself never leaves the page.
4. Let a plain article tab hibernate. Switch to it: it wakes, and **the Back button still works** —
   navigation history is restored via `navigationHistory.restore()`, not just the URL.
5. Mark a tab **Never sleep**. It reports PROTECTED and is never touched.
6. Press *Hibernate now* on a tab holding form text — it refuses. A button press is not a reason to
   destroy unsaved work; the row explains which guard applied.
7. Set mode **Off**. Nothing sleeps automatically, but suggestions still appear for manual use.
8. Open several tabs on the same site (e.g. three Wikipedia pages). At least two should share a
   renderer process: their rows show **"shared ÷N — estimate"**. Confirm the panel never presents a
   divided figure as a measurement.
9. Open Task Manager while tabs hibernate — the Electron renderer count really drops.

## Bug found and fixed during this phase

The "nothing to reclaim" fallback counted `already-hibernated` as a blocking condition, so a window
with three sleeping tabs reported *"3 background tabs are doing something that makes sleeping them
unsafe"* — both wrong and alarming. Now only genuinely unsafe blockers count, and a fully-asleep
window says so. Covered by a regression test.

## Known gaps carried into Phase 4

- FROZEN buys CPU, not memory. The panel does not claim a byte figure for it.
- Memory pressure is not read from the OS; `memoryPressureThreshold` exists in the policy but no
  platform probe feeds it, so automatic action is time-based only. A Rust sidecar
  (`ResourceSampler` is the named migration candidate) is the natural place for a real probe.
- `beforeunload` detection is reactive, not predictive: there is no API to ask whether a page has
  registered a handler, and the preload cannot see the page's `window` across context isolation. A
  page with a handler that has never been asked to unload will not be caught — the unsaved-input
  signal is the reliable guard.
- Hibernated tabs are not persisted, so a restart loses them entirely. Phase 6 fixes this.
