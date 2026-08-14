import { describe, it, expect } from 'vitest'
import { ViewLayoutManager } from './ViewLayoutManager'
import { CHROME_HEIGHT } from '@shared/constants'

describe('ViewLayoutManager', () => {
  it('insets the page area below the chrome band', () => {
    const rects = new ViewLayoutManager().compute(1440, 900)

    expect(rects.chrome).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(rects.page).toEqual({
      x: 0,
      y: CHROME_HEIGHT,
      width: 1440,
      height: 900 - CHROME_HEIGHT
    })
  })

  it('reserves the sidebar on the left of the page area only', () => {
    const layout = new ViewLayoutManager()
    layout.setSidebarWidth(240)
    const rects = layout.compute(1440, 900)

    expect(rects.page.x).toBe(240)
    expect(rects.page.width).toBe(1200)
    // The chrome view still owns the whole window — it is what draws the sidebar.
    expect(rects.chrome.width).toBe(1440)
  })

  it('clamps to zero rather than emitting negative bounds when the window is tiny', () => {
    // Chromium rejects negative dimensions, so a window shorter than the chrome
    // band must degrade to an empty page rect instead of a negative one.
    const rects = new ViewLayoutManager().compute(300, 40)

    expect(rects.page.height).toBe(0)
    expect(rects.page.y).toBe(40)
    expect(rects.page.width).toBeGreaterThanOrEqual(0)
  })

  it('clamps a sidebar wider than the window', () => {
    const layout = new ViewLayoutManager()
    layout.setSidebarWidth(999)
    const rects = layout.compute(400, 600)

    expect(rects.page.x).toBe(400)
    expect(rects.page.width).toBe(0)
  })

  it('rounds fractional bounds, since view bounds are integer pixels', () => {
    const rects = new ViewLayoutManager().compute(1023.6, 767.4)

    expect(Number.isInteger(rects.chrome.width)).toBe(true)
    expect(Number.isInteger(rects.chrome.height)).toBe(true)
    expect(rects.chrome.width).toBe(1024)
    expect(rects.chrome.height).toBe(767)
  })

  it('insets the page from the right when a panel is open', () => {
    const layout = new ViewLayoutManager()
    layout.setRightPanelWidth(360)
    const rects = layout.compute(1440, 900)

    expect(rects.page.x).toBe(0)
    expect(rects.page.width).toBe(1080)
    // The chrome still spans the window — it is what draws the panel.
    expect(rects.chrome.width).toBe(1440)
  })

  it('clamps a right panel wider than the remaining space', () => {
    const layout = new ViewLayoutManager()
    layout.setSidebarWidth(200)
    layout.setRightPanelWidth(9999)
    const rects = layout.compute(600, 600)

    expect(rects.page.width).toBe(0)
    expect(rects.page.x).toBe(200)
  })

  it('combines a left sidebar and a right panel', () => {
    const layout = new ViewLayoutManager()
    layout.setSidebarWidth(240)
    layout.setRightPanelWidth(360)
    const rects = layout.compute(1440, 900)

    expect(rects.page.x).toBe(240)
    expect(rects.page.width).toBe(840)
  })

  it('honours a custom chrome height', () => {
    const layout = new ViewLayoutManager()
    layout.setChromeHeight(120)

    expect(layout.compute(800, 600).page).toEqual({ x: 0, y: 120, width: 800, height: 480 })
  })
})
