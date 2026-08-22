/**
 * Splitting a restore point back into the windows it came from.
 *
 * Pure, because `SessionSnapshotManager` imports electron and cannot be tested
 * directly — and because the failure here is quiet. A snapshot restored into one
 * window still shows every page, so nothing looks broken; the user simply finds
 * the two windows they had arranged have become one, and has no way to tell
 * whether the browser forgot or never knew.
 */

export interface WindowIndexed {
  readonly windowIndex: number
  readonly order: number
}

/**
 * Tabs grouped by their original window, each group in its own tab order.
 *
 * Groups are returned in ascending window index, so the window a user thought of
 * as "first" is restored first and gets focus. Indices need not be contiguous —
 * a snapshot written while a private window was open has a gap, since private
 * windows are deliberately never recorded.
 *
 * An empty input gives an empty array rather than one empty window: restoring
 * nothing should open nothing.
 */
export function groupByWindow<T extends WindowIndexed>(tabs: readonly T[]): T[][] {
  const byWindow = new Map<number, T[]>()
  for (const tab of tabs) {
    // A negative or non-finite index would sort unpredictably against the real
    // ones; treated as window 0, which merges rather than losing the tab.
    const key = Number.isFinite(tab.windowIndex) && tab.windowIndex >= 0 ? Math.trunc(tab.windowIndex) : 0
    const existing = byWindow.get(key)
    if (existing) existing.push(tab)
    else byWindow.set(key, [tab])
  }

  return [...byWindow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => [...group].sort((a, b) => a.order - b.order))
}

/**
 * How many windows a restore point would open.
 *
 * Shown before restoring, because opening four windows when somebody expected
 * one is startling in a way that is hard to undo — every window has to be closed
 * by hand.
 */
export function windowCount(tabs: readonly WindowIndexed[]): number {
  return groupByWindow(tabs).length
}
