import { describe, it, expect } from 'vitest'
import {
  clampChip,
  chipPosition,
  defaultChipPosition,
  toSavedOffset,
  type Rect
} from './chipPosition'

/** A page area inset below the chrome, as the real layout produces. */
const page: Rect = { x: 0, y: 120, width: 1200, height: 780 }
const size = { width: 340, height: 96 }

describe('defaultChipPosition', () => {
  it('sits in the top-right of the page, not the window', () => {
    // The chrome is above; a chip at the window's top-right would be over the
    // toolbar rather than over the video.
    const at = defaultChipPosition(page, size)
    expect(at.y).toBe(page.y + 16)
    expect(at.x).toBe(page.x + page.width - size.width - 16)
  })

  it('does not go negative on a page narrower than the chip', () => {
    const at = defaultChipPosition({ x: 0, y: 0, width: 200, height: 400 }, size)
    expect(at.x).toBeGreaterThanOrEqual(0)
  })
})

describe('clampChip', () => {
  it('leaves a position that is already inside alone', () => {
    expect(clampChip({ x: 400, y: 300 }, page, size)).toEqual({ x: 400, y: 300 })
  })

  it('keeps the whole chip inside the right edge', () => {
    // The close button is at the chip's right-hand end — the exact part that
    // would go over the side first.
    const at = clampChip({ x: 5000, y: 300 }, page, size)
    expect(at.x + size.width).toBeLessThanOrEqual(page.x + page.width)
  })

  it('keeps it below the chrome', () => {
    const at = clampChip({ x: 400, y: 0 }, page, size)
    expect(at.y).toBeGreaterThanOrEqual(page.y)
  })

  it('keeps it inside the bottom edge', () => {
    const at = clampChip({ x: 400, y: 99999 }, page, size)
    expect(at.y + size.height).toBeLessThanOrEqual(page.y + page.height)
  })

  it('keeps it inside the left edge', () => {
    const at = clampChip({ x: -500, y: 300 }, page, size)
    expect(at.x).toBeGreaterThanOrEqual(page.x)
  })

  it('pins to the top-left when the page is smaller than the chip', () => {
    // No negative range invented: the window is too small for this to be tidy
    // either way, and being reachable matters more than being pretty.
    const tiny: Rect = { x: 10, y: 20, width: 100, height: 50 }
    const at = clampChip({ x: 9999, y: 9999 }, tiny, size)
    expect(at).toEqual({ x: 18, y: 28 })
  })
})

describe('chipPosition', () => {
  it('uses the corner when nothing was saved', () => {
    expect(chipPosition(null, page, size)).toEqual(defaultChipPosition(page, size))
  })

  it('restores a saved offset relative to the page', () => {
    const at = chipPosition({ x: 200, y: 50 }, page, size)
    expect(at).toEqual({ x: 200, y: page.y + 50 })
  })

  it('brings a saved position back into view on a smaller window', () => {
    // The failure this exists for: a chip dragged to the corner of a large
    // monitor, then reopened on a small one, would be off the edge entirely —
    // still shown, still impossible to reach or dismiss.
    const small: Rect = { x: 0, y: 120, width: 500, height: 400 }
    const at = chipPosition({ x: 900, y: 700 }, small, size)
    expect(at.x + size.width).toBeLessThanOrEqual(small.x + small.width)
    expect(at.y + size.height).toBeLessThanOrEqual(small.y + small.height)
  })
})

describe('toSavedOffset', () => {
  it('round-trips through chipPosition', () => {
    const moved = { x: 420, y: 400 }
    const saved = toSavedOffset(moved, page)
    expect(chipPosition(saved, page, size)).toEqual(moved)
  })

  it('stores relative to the page, not the window', () => {
    // Saving screen coordinates would move the chip whenever the chrome's
    // height changed — which it does, because the toolbar auto-hides.
    expect(toSavedOffset({ x: 100, y: 200 }, page)).toEqual({ x: 100, y: 80 })
  })
})
