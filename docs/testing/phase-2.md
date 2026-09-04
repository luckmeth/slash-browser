# Phase 2 — workspaces: test script

Run `docs/testing/phase-0.md` and `phase-1.md` first as regression checks.

## What Phase 2 actually gives you

Workspaces are **hybrid** by design, per the decision recorded in `docs/PLAN.md`:

- A normal workspace shares the profile's default session. Tabs move between such workspaces
  instantly and stay signed in. The workspace is purely organisational.
- An **isolated** workspace gets its own `persist:ws-<id>` partition: genuinely separate cookies,
  storage and cache. You can be signed into the same site as two different accounts side by side.

The cost is unavoidable and is stated in the UI rather than hidden: **a tab moved across an isolation
boundary reloads signed out**, because the credentials live in the partition, not in the tab. There
is no way to carry a session across.

`isolated` is fixed at creation and has no toggle. Flipping it on an existing workspace would strand
every cookie already written to the old partition, so the supported route is **Duplicate as
isolated**.

## Automated

```bash
npm run typecheck && npm test && npm run lint
```

## UI capture

```bash
ADAPTIVE_UI_CAPTURE=/tmp/ws.png npm run dev
```

Seeds a Work (isolated) and Research workspace. In the PNG confirm:

1. The rail shows three workspaces; the active one carries a coloured ring.
2. The isolated workspace has a **lock badge**. This is the one property a user must be able to see
   at a glance, since it changes which account they are signed in as.
3. The page view starts to the *right* of the rail — it is inset by `WORKSPACE_RAIL_WIDTH`, not
   overlapped. Both the renderer and `ViewLayoutManager` read that same constant; a mismatch would
   either clip the page or leave a dead strip.

**Result 2026-08-14: PASS.**

## Manual checks

### Switching
1. Click each rail entry. Switching is **instant and reloads nothing** — inactive workspaces keep
   their tabs and their `WebContentsView`s alive, only detached.
2. Switch away and back. The tab you were on is still active — the last-active tab is remembered per
   workspace.
3. `Ctrl+Shift+1`…`Ctrl+Shift+9` select by position; `Ctrl+Shift+]` / `[` cycle.
4. Switch to a workspace with no tabs — it opens a new tab rather than showing a blank window.

### Isolation (the important one)
5. In **Personal**, sign into any site. Switch to **Work** (isolated) and open the same site — you
   are signed out there, and can sign in as a different account.
6. Return to Personal. That session is untouched.
7. Drag a tab from Personal onto the Work icon in the rail. A confirmation appears stating the page
   will reload signed out. Cancel — nothing happens. Accept — the tab moves and reloads.
8. Drag a tab between two **non-isolated** workspaces. No warning, no reload, still signed in.

### Management
9. Right-click a rail entry (or the gear) to open the editor. Rename, change icon and colour.
10. Type in **Notes** — it autosaves after a pause, with no save button.
11. **Duplicate workspace** copies the settings and the open tab URLs. **Duplicate as isolated**
    does the same into a fresh partition — the copy starts signed out by definition.
12. Delete a workspace: its tabs close and you land on the default.
13. Try to delete the default workspace — it is refused, in the UI and again in the handler. A tab
    must always have somewhere to live.

### Non-goal, verified
14. Nothing auto-classifies tabs into workspaces. Grouping suggestions are Phase 7 and will always
    require approval.

## Known gaps carried into Phase 3

- Workspace tab membership is in memory only; it is not persisted across restarts. Phase 6's
  `SessionSnapshotManager` is what makes workspaces survive a quit.
- Rail entries cannot be reordered by dragging (the `sortOrder` column exists and is respected).
- Deleting an isolated workspace leaves its `persist:` partition on disk. The delete dialog says so
  rather than implying the data is gone; clearing it needs a Phase 4/5 storage control.
- Search within a workspace is not yet exposed; history is still global.
