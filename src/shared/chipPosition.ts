/**
 * Where the floating download chip sits, and how it is kept reachable.
 *
 * The chip is a native `WebContentsView` positioned by the main process, not a
 * CSS box — so moving it is moving a view, and nothing about the browser's
 * layout stops it being put somewhere useless. A chip dragged to the bottom
 * corner of a large monitor and then reopened on a small one would be off the
 * edge entirely: still "shown", still swallowing nothing, and impossible to
 * reach or dismiss.
 *
 * So every position goes through `clampChip`, on the way in and on the way out.
 * Pure, because "can the user still get at it" is not a thing to discover from
 * a window somebody resized.
 */

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * How much of the chip must stay inside the page area.
 *
 * All of it. A chip half off the edge looks broken rather than tucked away, and
 * the close button is at its right-hand end — the exact part that would go over
 * the side first.
 */
const MARGIN = 8

/** The corner it appears in before anybody has moved it. */
export function defaultChipPosition(page: Rect, size: { width: number; height: number }): Point {
  return {
    // Top-right of the page area, where a player's own controls are not.
    x: Math.max(page.x, page.x + page.width - size.width - 16),
    y: page.y + 16
  }
}

/**
 * The nearest position to `desired` that keeps the whole chip inside the page.
 *
 * Clamped rather than refused: somebody dragging towards the edge means "as far
 * over as it goes", and a drag that stops responding near the boundary reads as
 * the window being broken.
 *
 * A page smaller than the chip pins it to the top-left rather than producing a
 * negative range — the window is then too small for this to be tidy either way,
 * and being reachable matters more than being pretty.
 */
export function clampChip(
  desired: Point,
  page: Rect,
  size: { width: number; height: number }
): Point {
  const minX = page.x + MARGIN
  const minY = page.y + MARGIN
  const maxX = page.x + page.width - size.width - MARGIN
  const maxY = page.y + page.height - size.height - MARGIN

  return {
    x: maxX < minX ? minX : Math.min(Math.max(desired.x, minX), maxX),
    y: maxY < minY ? minY : Math.min(Math.max(desired.y, minY), maxY)
  }
}

/**
 * Where the chip should go, given what the user last chose.
 *
 * `saved` is stored relative to the **page area**, not the screen, so the chip
 * lands in the same place on a window of a different size — and clamping then
 * catches the cases where it cannot.
 */
export function chipPosition(
  saved: Point | null,
  page: Rect,
  size: { width: number; height: number }
): Point {
  const desired = saved
    ? { x: page.x + saved.x, y: page.y + saved.y }
    : defaultChipPosition(page, size)
  return clampChip(desired, page, size)
}

/** The offset to store: relative to the page, so it survives a resize. */
export function toSavedOffset(position: Point, page: Rect): Point {
  return { x: position.x - page.x, y: position.y - page.y }
}
