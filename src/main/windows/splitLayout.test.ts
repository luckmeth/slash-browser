import { describe, it, expect } from 'vitest'
import {
  splitRects,
  canSplit,
  SPLIT_GUTTER,
  MIN_PANE_WIDTH,
  MIN_SPLIT_FRACTION,
  MAX_SPLIT_FRACTION
} from './splitLayout'

const page = { x: 10, y: 44, width: 1200, height: 800 }

describe('splitRects', () => {
  it('divides the hole in half with a gutter between the panes', () => {
    const rects = splitRects(page, 0.5)
    expect(rects).not.toBeNull()
    const { primary, secondary } = rects!
    expect(primary.x).toBe(page.x)
    expect(secondary.x).toBe(primary.x + primary.width + SPLIT_GUTTER)
    // Every pixel of the hole is used except the gutter.
    expect(primary.width + secondary.width + SPLIT_GUTTER).toBe(page.width)
  })

  it('keeps both panes inside the hole at every fraction', () => {
    for (const fraction of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const { primary, secondary } = splitRects(page, fraction)!
      expect(primary.x).toBeGreaterThanOrEqual(page.x)
      expect(secondary.x + secondary.width).toBeLessThanOrEqual(page.x + page.width)
      expect(primary.width).toBeGreaterThan(0)
      expect(secondary.width).toBeGreaterThan(0)
    }
  })

  it('clamps the divider so neither pane can be dragged away entirely', () => {
    const far = splitRects(page, 0.99)!
    const atMax = splitRects(page, MAX_SPLIT_FRACTION)!
    expect(far.primary.width).toBe(atMax.primary.width)

    const near = splitRects(page, -5)!
    const atMin = splitRects(page, MIN_SPLIT_FRACTION)!
    expect(near.primary.width).toBe(atMin.primary.width)
  })

  it('refuses to split a hole too narrow for two usable panes', () => {
    const narrow = { ...page, width: MIN_PANE_WIDTH * 2 }
    expect(splitRects(narrow, 0.5)).toBeNull()
    expect(canSplit(narrow)).toBe(false)
    // One pixel over the requirement is enough.
    expect(canSplit({ ...page, width: MIN_PANE_WIDTH * 2 + SPLIT_GUTTER })).toBe(true)
  })

  it('falls back to an even split when the fraction would starve a pane', () => {
    // Wide enough for two panes, but 20% of it is under the minimum — the
    // fraction clamp alone does not save this case.
    const snug = { ...page, width: MIN_PANE_WIDTH * 2 + SPLIT_GUTTER + 40 }
    const { primary, secondary } = splitRects(snug, MIN_SPLIT_FRACTION)!
    expect(primary.width).toBeGreaterThanOrEqual(MIN_PANE_WIDTH)
    expect(secondary.width).toBeGreaterThanOrEqual(MIN_PANE_WIDTH)
    expect(primary.width + secondary.width + SPLIT_GUTTER).toBe(snug.width)
  })

  it('splits top and bottom when the divider is horizontal', () => {
    const { primary, secondary } = splitRects(page, 0.5, 'horizontal')!
    expect(primary.x).toBe(secondary.x)
    expect(primary.width).toBe(page.width)
    expect(secondary.y).toBe(primary.y + primary.height + SPLIT_GUTTER)
    expect(primary.height + secondary.height + SPLIT_GUTTER).toBe(page.height)
  })

  it('refuses a horizontal split in a hole too short for two panes', () => {
    expect(canSplit({ ...page, height: 100 }, 'horizontal')).toBe(false)
  })

  it('never returns a negative or zero-size pane', () => {
    for (const width of [0, 1, 320, 640, 641, 1920, 3840]) {
      const rects = splitRects({ ...page, width }, 0.5)
      if (!rects) continue
      expect(rects.primary.width).toBeGreaterThan(0)
      expect(rects.secondary.width).toBeGreaterThan(0)
    }
  })
})
