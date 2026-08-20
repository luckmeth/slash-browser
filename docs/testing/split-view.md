# Split view

Two pages side by side in one window. The one feature here that can typecheck perfectly and render
nothing, because it is two native views positioned by arithmetic — a wrong rectangle puts a pane
off-screen or at zero width and raises no error anywhere.

Reproduce with:

```bash
npm run build && SLASH_SPLIT_CAPTURE=split.png npx electron-vite preview
```

## What it does

- **Two panes, one active tab.** `splitTabId` is deliberately separate from `activeTabId`. The
  omnibox, find bar, zoom and every per-tab control still follow the active tab, so there is exactly
  one tab the browser considers current. Splitting shows two pages; it does not create a second
  cursor. While split, the active tab carries an accent ring in the strip — with two tabs lit, which
  one is active stops being obvious and it still decides where typing lands.
- **Entry points.** `Ctrl+Shift+S` splits with the neighbouring tab (the common case); the tab
  context menu's "Split view with this tab" picks a specific partner. View → Swap Split Panes and
  Stack Split Panes handle the rest.
- **The divider is real.** Drag it, or focus it and use the arrow keys.

## The two architectural facts

**Two attached views is a deliberate exception.** The standing rule is that only the active tab's
view is attached, because Chromium composites every attached view and N attached views cost GPU work
for N-1 invisible pages. Here both panes are genuinely visible, so both are genuinely worth
compositing. It is capped at two for exactly that reason — a four-pane grid would be four live
renderers composited at once, and that is a different performance conversation.

**The drag handle can live in the chrome document.** Panels cannot — a `WebContentsView` composites
above the DOM, which is the bug that made the shield panel invisible. The divider is the exception
because it sits in the *gutter*, the strip deliberately left uncovered between the two page views.
There is no page above it. Its coordinates are published by the main process in `splitGeometry`
rather than recomputed in React: the panes are laid out in DIP by `layoutPanes`, and a second copy
of that arithmetic would drift from the real seam and put the handle beside it.

## Refusals, and why they are refusals

- **A window too narrow for two usable panes cannot split.** Below `MIN_PANE_WIDTH` (320) a pane
  triggers sites' own mobile breakpoints and renders as a broken page, so a sliver is worse than no
  split. `canSplit` is published so the context-menu item is *disabled* rather than hidden — a
  feature that vanishes reads as a bug.
- **Narrowing the window past that drops the split.** Widening again does not silently restore it:
  reinstating a layout the user last saw disappear is worse than letting them ask for it back.
- **No splitting across workspaces.** Two partitions side by side under one tab strip reads as one
  context and is not.
- **A hibernated, internal or errored second tab suspends the split** rather than leaving a hole
  where a pane should be.

## What the probe checks

Against live pages, reading bounds back from the views themselves — intent and reality disagreeing
is the whole failure mode:

```
split probe: accepted=true splitTabId=tab-mt1mnbfv-2
split probe: content view children=3
split probe: panes {"primary":{"x":66,"y":84,"width":678,"height":806},
                    "secondary":{"x":752,"y":84,"width":678,"height":806}}
split probe: PASS — two panes, side by side, inside the content area
split probe: PASS — the drag handle lands in the gutter between the panes
split probe: primary width 678 -> 949
split probe: PASS — the divider resizes the panes
split probe: PASS — swapping exchanges the two panes
split probe: PASS — closing a pane ends the split
```

`splitLayout.test.ts` covers the geometry itself: panes stay inside the hole at every fraction, the
divider clamps so neither pane can be dragged away, a hole too small refuses, and a fraction that
would starve a pane falls back to an even split.

**Note on the screenshots:** `captureWindowTo` returns a blank frame on this machine — a Windows
Graphics Capture limitation with an occluded window, not an app fault. The geometry assertions above
are the verification; the `.png` files are not.

## Regression checks

1. Split, then use the omnibox — it must navigate the **active** pane, not the other one.
2. Split, then Ctrl+F — find must run in the active pane.
3. Split, then close the *active* tab: the split ends and the remaining page fills the window.
4. Split, then switch workspaces and back: the split belongs to the workspace it was made in.
5. Narrow the window until the split drops, then widen it: it stays dropped.
6. Split, then hibernate the second pane's tab via the performance panel: the split suspends
   cleanly rather than leaving a gap.
