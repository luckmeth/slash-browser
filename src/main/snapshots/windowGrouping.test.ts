import { describe, it, expect } from 'vitest'
import { groupByWindow, windowCount } from './windowGrouping'

const tab = (windowIndex: number, order: number, url = `p${order}`) => ({ windowIndex, order, url })

describe('groupByWindow', () => {
  it('separates tabs that came from different windows', () => {
    // The whole point: a snapshot restored into one window still shows every
    // page, so nothing looks broken — the user just finds the arrangement they
    // built has silently become a single window.
    const groups = groupByWindow([tab(0, 0, 'a'), tab(1, 0, 'b'), tab(0, 1, 'c')])
    expect(groups.map((group) => group.map((t) => t.url))).toEqual([['a', 'c'], ['b']])
  })

  it('restores tab order within each window', () => {
    const groups = groupByWindow([tab(0, 2, 'c'), tab(0, 0, 'a'), tab(0, 1, 'b')])
    expect(groups[0]?.map((t) => t.url)).toEqual(['a', 'b', 'c'])
  })

  it('returns windows in ascending index so the first window gets focus', () => {
    const groups = groupByWindow([tab(2, 0, 'third'), tab(0, 0, 'first'), tab(1, 0, 'second')])
    expect(groups.map((group) => group[0]?.url)).toEqual(['first', 'second', 'third'])
  })

  it('copes with gaps in the indices', () => {
    // A snapshot written while a private window was open has a gap: private
    // windows are never recorded.
    expect(groupByWindow([tab(0, 0), tab(3, 0)]).length).toBe(2)
  })

  it('folds a nonsense index into the first window rather than dropping the tab', () => {
    const groups = groupByWindow([tab(0, 0, 'a'), tab(Number.NaN, 1, 'b'), tab(-4, 2, 'c')])
    expect(groups.length).toBe(1)
    expect(groups[0]?.map((t) => t.url)).toEqual(['a', 'b', 'c'])
  })

  it('gives no windows for no tabs', () => {
    // Restoring nothing should open nothing, not one empty window.
    expect(groupByWindow([])).toEqual([])
  })

  it('does not mutate the array it was given', () => {
    const tabs = [tab(0, 2, 'c'), tab(0, 0, 'a')]
    groupByWindow(tabs)
    expect(tabs.map((t) => t.url)).toEqual(['c', 'a'])
  })
})

describe('windowCount', () => {
  it('counts distinct windows, for the warning shown before restoring', () => {
    // Opening four windows when somebody expected one is startling in a way
    // that is tedious to undo.
    expect(windowCount([tab(0, 0), tab(0, 1), tab(1, 0), tab(5, 0)])).toBe(3)
    expect(windowCount([])).toBe(0)
  })
})
