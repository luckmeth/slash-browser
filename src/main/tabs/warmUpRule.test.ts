import { describe, it, expect } from 'vitest'
import { shouldWarmUp, type WarmUpFacts } from './warmUpRule'

const facts = (over: Partial<WarmUpFacts> = {}): WarmUpFacts => ({
  url: 'https://example.com/',
  hasSavedNavigation: false,
  hasRenderer: false,
  hasScripts: true,
  ...over
})

describe('shouldWarmUp', () => {
  it('warms a fresh tab on its way to a real page', () => {
    expect(shouldWarmUp(facts())).toBe(true)
  })

  it('never warms a tab that is being restored', () => {
    // The regression this file exists for. `navigationHistory.restore()`
    // replaces the entry list on a *pristine* WebContents; give it one that has
    // already committed a blank document and it replaces the entries without
    // navigating. Reopening the browser showed a black window with the right
    // address in the omnibox, on every restored tab.
    expect(shouldWarmUp(facts({ hasSavedNavigation: true }))).toBe(false)
  })

  it('refuses a restore even when everything else says yes', () => {
    // Checked first, deliberately, so no later clause can talk it back.
    expect(
      shouldWarmUp(
        facts({ hasSavedNavigation: true, hasRenderer: false, hasScripts: true })
      )
    ).toBe(false)
  })

  it('does not warm a view that already has a renderer', () => {
    // Typing an address into a page you are reading. A blank document there is a
    // visible flash and an entry in somebody's back history, bought for an
    // install that has already happened.
    expect(shouldWarmUp(facts({ hasRenderer: true }))).toBe(false)
  })

  it('does not warm when every page script is switched off', () => {
    expect(shouldWarmUp(facts({ hasScripts: false }))).toBe(false)
  })

  it.each([
    'https://www.youtube.com/watch?v=x',
    'http://example.com/',
    'https://example.com:8443/path?q=1'
  ])('warms for %s', (url) => {
    expect(shouldWarmUp(facts({ url }))).toBe(true)
  })

  it.each(['about:blank', 'file:///C:/page.html', 'slash://newtab', 'data:text/html,x', 'nonsense'])(
    'does not warm for %s',
    (url) => {
      expect(shouldWarmUp(facts({ url }))).toBe(false)
    }
  )
})
