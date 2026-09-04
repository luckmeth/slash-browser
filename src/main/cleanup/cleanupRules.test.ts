import { describe, it, expect } from 'vitest'
import {
  PRESERVE_SELECTORS,
  describeResult,
  isDisabledForHost,
  planCleanup,
  toggleHost
} from './cleanupRules'

describe('planCleanup', () => {
  it('escalates strictly: each mode is a superset of the one below', () => {
    const light = planCleanup('light').selectors
    const balanced = planCleanup('balanced').selectors
    const aggressive = planCleanup('aggressive').selectors

    // A mode that dropped a rule the gentler mode had would make "stronger"
    // meaningless.
    for (const selector of light) expect(balanced).toContain(selector)
    for (const selector of balanced) expect(aggressive).toContain(selector)
    expect(aggressive.length).toBeGreaterThan(balanced.length)
    expect(balanced.length).toBeGreaterThan(light.length)
  })

  it('keeps the riskiest behaviours to aggressive only', () => {
    // Hiding fixed elements removes site navigation more often than ads, and
    // pausing media is wrong on a page you opened to watch something.
    expect(planCleanup('light').hideFixed).toBe(false)
    expect(planCleanup('balanced').hideFixed).toBe(false)
    expect(planCleanup('aggressive').hideFixed).toBe(true)

    expect(planCleanup('light').pauseMedia).toBe(false)
    expect(planCleanup('balanced').pauseMedia).toBe(false)
    expect(planCleanup('aggressive').pauseMedia).toBe(true)
  })

  it('warns about aggressive before it is used', () => {
    expect(planCleanup('aggressive').description).toContain('Restore')
  })

  it('describes every mode', () => {
    for (const mode of ['light', 'balanced', 'aggressive'] as const) {
      expect(planCleanup(mode).description.length).toBeGreaterThan(20)
    }
  })

  it('never targets the content the user came for', () => {
    // The failure that matters: hiding the article, the video or a form is not
    // cleaning the page, it is breaking it.
    const aggressive = planCleanup('aggressive').selectors.join(' ')
    for (const preserved of ['main', 'article', 'video', 'audio', 'form', 'table']) {
      expect(aggressive).not.toContain(`${preserved},`)
      expect(aggressive.split(/[\s,]+/)).not.toContain(preserved)
    }
  })

  it('lists the elements that must survive', () => {
    expect(PRESERVE_SELECTORS).toContain('main')
    expect(PRESERVE_SELECTORS).toContain('article')
    expect(PRESERVE_SELECTORS).toContain('video')
    expect(PRESERVE_SELECTORS).toContain('form')
  })
})

describe('isDisabledForHost', () => {
  it('matches regardless of www', () => {
    expect(isDisabledForHost('www.example.com', ['example.com'])).toBe(true)
    expect(isDisabledForHost('example.com', ['www.example.com'])).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isDisabledForHost('Example.COM', ['example.com'])).toBe(true)
  })

  it('does not match a different site', () => {
    // A wildcard would be surprising in the other direction.
    expect(isDisabledForHost('example.com', ['notexample.com'])).toBe(false)
    expect(isDisabledForHost('sub.example.com', ['example.com'])).toBe(false)
  })

  it('handles an empty list', () => {
    expect(isDisabledForHost('example.com', [])).toBe(false)
  })
})

describe('toggleHost', () => {
  it('adds then removes', () => {
    const once = toggleHost('example.com', [])
    expect(once).toEqual(['example.com'])
    expect(toggleHost('example.com', once)).toEqual([])
  })

  it('never duplicates an entry', () => {
    expect(toggleHost('www.example.com', ['example.com'])).toEqual([])
  })

  it('ignores an empty host', () => {
    expect(toggleHost('', ['example.com'])).toEqual(['example.com'])
  })
})

describe('describeResult', () => {
  it('reports doing nothing as doing nothing', () => {
    // "Cleaned" on a page where nothing changed teaches the user the button lies.
    expect(describeResult(0, 0, false)).toContain('Nothing to clean')
  })

  it('counts what it did and says how to undo it', () => {
    const text = describeResult(3, 1, true)
    expect(text).toContain('Hid 3 elements')
    expect(text).toContain('paused 1 media element')
    expect(text).toContain('scrolls')
    expect(text).toContain('Reload')
  })

  it('gets singulars right', () => {
    expect(describeResult(1, 0, false)).toContain('Hid 1 element.')
  })
})
