import type { Rectangle } from 'electron'

/** Gutter between the two panes, in DIP. Matches the page inset. */
export const SPLIT_GUTTER = 8

/**
 * Narrowest a pane may become before splitting is refused.
 *
 * Below this a page is not usable — most sites' own minimum widths are wider —
 * so a split that would produce a sliver is better not offered at all.
 */
export const MIN_PANE_WIDTH = 320

/** How far the divider may be dragged, as a fraction of the content hole. */
export const MIN_SPLIT_FRACTION = 0.2
export const MAX_SPLIT_FRACTION = 0.8

export type SplitOrientation = 'vertical' | 'horizontal'

/**
 * Divides the content hole into two panes.
 *
 * Pure and separate from `ViewLayoutManager` because the manager owns *one*
 * content hole and that stays true: split view is a division of the hole, not a
 * second hole. Keeping it a function means every clamp here is unit-tested
 * without constructing a window.
 *
 * `vertical` means the divider is vertical — panes side by side.
 *
 * Returns null when the space cannot hold two usable panes. Callers must treat
 * that as "cannot split" rather than falling back to a sliver, because a pane
 * narrower than most sites' own minimum width renders as a broken page.
 */
export function splitRects(
  page: Rectangle,
  fraction: number,
  orientation: SplitOrientation = 'vertical'
): { primary: Rectangle; secondary: Rectangle } | null {
  const clamped = Math.min(MAX_SPLIT_FRACTION, Math.max(MIN_SPLIT_FRACTION, fraction))

  if (orientation === 'vertical') {
    const usable = page.width - SPLIT_GUTTER
    if (usable < MIN_PANE_WIDTH * 2) return null

    const primaryWidth = Math.round(usable * clamped)
    const secondaryWidth = usable - primaryWidth
    // The clamp above bounds the *fraction*, not the pixels it produces: a
    // narrow window can put a 20% pane under the usable minimum while still
    // leaving room for two panes overall.
    if (primaryWidth < MIN_PANE_WIDTH || secondaryWidth < MIN_PANE_WIDTH) {
      const half = Math.floor(usable / 2)
      return {
        primary: { ...page, width: half },
        secondary: { ...page, x: page.x + half + SPLIT_GUTTER, width: usable - half }
      }
    }

    return {
      primary: { ...page, width: primaryWidth },
      secondary: { ...page, x: page.x + primaryWidth + SPLIT_GUTTER, width: secondaryWidth }
    }
  }

  const usable = page.height - SPLIT_GUTTER
  // Half of the width minimum: a short pane is cramped but still renders a
  // usable page, where a narrow one triggers sites' own mobile breakpoints.
  const minHeight = MIN_PANE_WIDTH / 2
  if (usable < minHeight * 2) return null

  const primaryHeight = Math.round(usable * clamped)
  const secondaryHeight = usable - primaryHeight
  if (primaryHeight < minHeight || secondaryHeight < minHeight) {
    const half = Math.floor(usable / 2)
    return {
      primary: { ...page, height: half },
      secondary: { ...page, y: page.y + half + SPLIT_GUTTER, height: usable - half }
    }
  }

  return {
    primary: { ...page, height: primaryHeight },
    secondary: { ...page, y: page.y + primaryHeight + SPLIT_GUTTER, height: secondaryHeight }
  }
}

/** Whether the content hole can hold two usable panes at all. */
export function canSplit(page: Rectangle, orientation: SplitOrientation = 'vertical'): boolean {
  return splitRects(page, 0.5, orientation) !== null
}
