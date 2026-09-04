# Phase 6 — time machine and session restore: test script

Run `phase-0.md` through `phase-4.md` first as regression checks.

## What changed

Before this phase, closing the browser lost every open tab. Now a session-end snapshot is written on
quit and restored on launch, plus automatic restore points every five minutes and named ones on
demand.

## What a snapshot genuinely restores

| Restored | Not restored |
|---|---|
| Which tabs were open, and their order | Being signed in, beyond what the cookies already carry |
| Pinned state and workspace | Anything a single-page app held only in memory |
| Scroll position | Form contents (unless `restoreFormState` is on — see below) |
| **Full back/forward history** | |

The last row is the one most session restores get wrong: restoring only the final URL silently
discards the user's trail. `navigationHistory.restore()` brings the whole list back.

## A deliberate privacy decision

Chromium's `pageState` blob carries scroll position **and form values**. Storing it would write
whatever has been typed into a form — including a half-entered password — into the local database.

So it is **stripped by default**. Scroll position is captured separately via `window.scrollY`, which
carries no such risk. Turning on Settings → `restoreFormState` opts into storing page state, and the
setting says exactly what that means.

## Automated

```bash
npm run typecheck && npm test && npm run lint
```

## Runtime verification — two process launches

Restoring from an in-memory object would prove nothing: the claim is that a session survives the
process dying, so the process has to actually die.

```bash
ADAPTIVE_SNAPSHOT_CAPTURE=record npm run dev
```

Opens two tabs, navigates one of them twice so it has real back-history, then quits normally.

```
snapshot record: 2 tab(s) open, quitting normally
timemachine: captured session-end snapshot #1 with 2 tab(s)
```

```bash
ADAPTIVE_SNAPSHOT_CAPTURE=verify ADAPTIVE_SNAPSHOT_OUT=/tmp/restore.png npm run dev
```

```
main: startup: restored 2 tab(s) from the previous session
snapshot verify: 2 tab(s) came back
snapshot verify: PASS — restored tabs are hibernated until activated
snapshot verify: PASS — back/forward history survived the restart
```

**Result 2026-08-15: PASS.**

Restored tabs deliberately arrive **hibernated**. Reopening forty tabs must not launch forty
renderer processes at once — they materialise on activation, reusing the Phase 3 mechanism so a
restored tab and a woken tab take one identical code path.

## Manual checks

1. Open several tabs across two workspaces, pin one, scroll one down. Quit and relaunch. Tab set,
   order, pinning and workspace all come back; the scrolled tab returns to where you were.
2. Press Back on a restored tab — it works. This is the difference between restoring a session and
   just reopening URLs.
3. Open Restore Points (`Ctrl+Shift+R`). Entries are grouped Today / Yesterday / date, with manual
   points starred.
4. Save a named restore point, close some tabs, then *Restore all* — they come back.
5. *Restore into a new workspace* puts everything in a fresh workspace instead of the original ones.
   The new workspace is never isolated: an isolated one has its own cookie partition, so restoring
   into it would silently sign every tab out.
6. Expand a restore point and *Reopen* a single tab. It lands in the workspace you are looking at.
7. Turn off `restoreTabsOnStartup` in Settings and relaunch — you get a clean window, and the
   snapshot is still listed for manual restore.
8. Set `snapshotRetentionDays` to 1 and confirm older automatic points are pruned. Named restore
   points are never pruned, because naming one is a clear statement that it should stay.

## Known limitations

- **Only the first restored tab is activated**, so exactly one renderer starts at launch. This is
  intentional, not a bug.
- **Snapshots are per-database, not per-window.** Restoring into a window puts every tab there
  regardless of which window they came from. Multi-window layout restoration is not implemented and
  the UI does not claim it.
- **An expired login lands on a sign-in page.** No snapshotting can change that, and the panel says
  so rather than implying a full session restore.
