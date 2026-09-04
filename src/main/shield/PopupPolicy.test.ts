import { describe, it, expect } from 'vitest'
import { decidePopup, GESTURE_WINDOW_MS, type PopupFacts } from './PopupPolicy'

const facts = (over: Partial<PopupFacts> = {}): PopupFacts => ({
  targetHost: 'ads.example.net',
  pageHost: 'video.example.com',
  msSinceGesture: null,
  opensFromThisGesture: 0,
  mode: 'standard',
  siteAllowsPopups: false,
  siteLocked: false,
  isCrossSite: true,
  targetIsKnownAdHost: false,
  ...over
})

describe('decidePopup', () => {
  it('blocks a window the page opened on its own', () => {
    const verdict = decidePopup(facts({ msSinceGesture: null }))
    expect(verdict).toEqual({ action: 'block', reason: 'no-user-gesture' })
  })

  it('allows a window opened right after a click', () => {
    const verdict = decidePopup(facts({ msSinceGesture: 40 }))
    expect(verdict).toEqual({ action: 'allow', reason: 'user-gesture' })
  })

  it('allows a click that had to do some work first', () => {
    expect(decidePopup(facts({ msSinceGesture: GESTURE_WINDOW_MS })).action).toBe('allow')
  })

  it('stops a page banking a click and spending it later', () => {
    // The pattern: you click, nothing opens, and a window appears seconds later.
    expect(decidePopup(facts({ msSinceGesture: GESTURE_WINDOW_MS + 1 })).reason).toBe(
      'no-user-gesture'
    )
  })

  it('allows the first window from a click and blocks the second', () => {
    // Pop-under: the page you wanted opens, and something rides along with it.
    expect(decidePopup(facts({ msSinceGesture: 20, opensFromThisGesture: 0 })).action).toBe('allow')
    expect(decidePopup(facts({ msSinceGesture: 20, opensFromThisGesture: 1 }))).toEqual({
      action: 'block',
      reason: 'repeated-from-one-gesture'
    })
  })

  it('honours an explicit popup exception for the site', () => {
    const verdict = decidePopup(facts({ siteAllowsPopups: true, msSinceGesture: null }))
    expect(verdict).toEqual({ action: 'allow', reason: 'site-allows-popups' })
  })

  it('lets site lock outrank a popup exception, but only across sites', () => {
    // Site lock is per-tab, explicit, and visible while it is on, so it wins.
    expect(
      decidePopup(facts({ siteLocked: true, siteAllowsPopups: true, isCrossSite: true })).reason
    ).toBe('site-locked')
    // A site's own popups keep working under lock.
    expect(
      decidePopup(facts({ siteLocked: true, siteAllowsPopups: true, isCrossSite: false })).action
    ).toBe('allow')
  })

  it('blocks unclicked cross-site windows in strict mode only', () => {
    const clickedCrossSite = { msSinceGesture: 20, isCrossSite: true } as const
    expect(decidePopup(facts({ ...clickedCrossSite, mode: 'standard' })).action).toBe('allow')
    expect(decidePopup(facts({ ...clickedCrossSite, mode: 'strict' }))).toEqual({
      action: 'block',
      reason: 'cross-site-strict'
    })
  })

  it('allows a clicked same-site window even in strict mode', () => {
    expect(
      decidePopup(facts({ mode: 'strict', isCrossSite: false, msSinceGesture: 20 })).action
    ).toBe('allow')
  })

  it('blocks a clicked window to an ad host, because a click is not consent to an advert', () => {
    // The streaming-site pattern: the play button is real and so is the click,
    // and the window it opens goes to an ad network. Without this rule every
    // click on such a page buys one more ad tab.
    expect(decidePopup(facts({ msSinceGesture: 20, targetIsKnownAdHost: true }))).toEqual({
      action: 'block',
      reason: 'known-ad-host'
    })
  })

  it('keeps blocking ad windows however many times the page is clicked', () => {
    // Each fresh click resets the one-window-per-gesture budget, so that rule
    // alone never stops the third or the tenth.
    for (const opens of [0, 1, 2]) {
      expect(
        decidePopup(facts({ msSinceGesture: 20, opensFromThisGesture: opens, targetIsKnownAdHost: true }))
          .action
      ).toBe('block')
    }
  })

  it('does not touch a site opening its own windows, ad host or not', () => {
    // Same-site only: an ad domain that opens a window on itself is its business.
    expect(
      decidePopup(facts({ msSinceGesture: 20, isCrossSite: false, targetIsKnownAdHost: true }))
        .action
    ).toBe('allow')
  })

  it('still honours an explicit popup exception for the site', () => {
    // The user said "always allow popups here" — that outranks the blocklist,
    // because it is a specific instruction about this site.
    expect(
      decidePopup(facts({ msSinceGesture: 20, siteAllowsPopups: true, targetIsKnownAdHost: true }))
        .action
    ).toBe('allow')
  })
})
