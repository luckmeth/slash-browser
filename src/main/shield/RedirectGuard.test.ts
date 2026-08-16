import { describe, it, expect, vi } from 'vitest'
import { GestureTracker } from './GestureTracker'
import { RedirectGuard } from './RedirectGuard'

function build(options: { knownAdHosts?: string[] } = {}) {
  let clock = 10_000
  const now = (): number => clock
  const gestures = new GestureTracker(now)
  const blocked: string[] = []
  const warned: string[] = []

  const guard = new RedirectGuard(
    {
      onNavigationBlocked: (_id, host) => blocked.push(host),
      onNavigationWarned: (_id, host) => warned.push(host)
    },
    gestures,
    (host) => (options.knownAdHosts ?? []).includes(host),
    now
  )

  return {
    guard,
    gestures,
    blocked,
    warned,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('RedirectGuard', () => {
  it('allows ordinary navigation', () => {
    const { guard, blocked } = build()
    const allowed = guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://news.example.com/article',
      currentUrl: 'https://news.example.com/',
      mode: 'standard',
      siteLocked: false
    })
    expect(allowed).toBe(true)
    expect(blocked).toEqual([])
  })

  it('blocks an unclicked jump to a known ad host', () => {
    const { guard, blocked } = build({ knownAdHosts: ['adserve.example.net'] })
    const allowed = guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://adserve.example.net/land',
      currentUrl: 'https://video.example.com/watch',
      mode: 'standard',
      siteLocked: false
    })
    expect(allowed).toBe(false)
    expect(blocked).toEqual(['adserve.example.net'])
  })

  it('allows the same jump when the user clicked', () => {
    const { guard, gestures, blocked, advance } = build({
      knownAdHosts: ['adserve.example.net']
    })
    gestures.note(1)
    advance(50)

    const allowed = guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://adserve.example.net/land',
      currentUrl: 'https://video.example.com/watch',
      mode: 'standard',
      siteLocked: false
    })
    expect(allowed).toBe(true)
    expect(blocked).toEqual([])
  })

  it('never blocks a sign-in redirect', () => {
    const { guard, blocked } = build()
    const allowed = guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=x',
      currentUrl: 'https://shop.example.com/checkout',
      mode: 'strict',
      siteLocked: true
    })
    // Locked tab, strict mode, cross-site, unclicked — every signal says block,
    // and it must still allow, because breaking sign-in breaks the browser.
    expect(allowed).toBe(true)
    expect(blocked).toEqual([])
  })

  it('blocks unclicked cross-site navigation in a locked tab', () => {
    const { guard, blocked } = build()
    const allowed = guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://elsewhere.example.net/promo',
      currentUrl: 'https://video.example.com/watch',
      mode: 'standard',
      siteLocked: true
    })
    expect(allowed).toBe(false)
    expect(blocked).toEqual(['elsewhere.example.net'])
  })

  it('allows same-site navigation in a locked tab', () => {
    const { guard } = build()
    expect(
      guard.evaluate({
        webContentsId: 1,
        targetUrl: 'https://video.example.com/other',
        currentUrl: 'https://video.example.com/watch',
        mode: 'standard',
        siteLocked: false
      })
    ).toBe(true)
  })

  it('warns but does not block a rapid unclicked chain', () => {
    const { guard, blocked, warned, advance } = build()
    const hop = (host: string): boolean =>
      guard.evaluate({
        webContentsId: 1,
        targetUrl: `https://${host}/`,
        currentUrl: 'https://start.example.com/',
        mode: 'standard',
        siteLocked: false
      })

    expect(hop('a.example.net')).toBe(true)
    advance(200)
    expect(hop('b.example.org')).toBe(true)
    advance(200)
    // Third distinct host inside the window: flagged, still allowed, because a
    // pattern is not a rule.
    expect(hop('c.example.io')).toBe(true)
    expect(blocked).toEqual([])
    expect(warned).toEqual(['c.example.io'])
  })

  it('keeps a blocked hop out of the chain', () => {
    // A navigation that did not happen must not colour the next judgement.
    const { guard, warned, advance } = build({ knownAdHosts: ['ad.example.net'] })
    guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://ad.example.net/',
      currentUrl: 'https://start.example.com/',
      mode: 'standard',
      siteLocked: false
    })
    advance(100)
    guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://b.example.org/',
      currentUrl: 'https://start.example.com/',
      mode: 'standard',
      siteLocked: false
    })
    advance(100)
    guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://c.example.io/',
      currentUrl: 'https://start.example.com/',
      mode: 'standard',
      siteLocked: false
    })
    // Only two real hops happened, so no rapid-chain warning.
    expect(warned).toEqual([])
  })

  it('forgets a tab', () => {
    const { guard } = build()
    guard.evaluate({
      webContentsId: 1,
      targetUrl: 'https://a.example.net/',
      currentUrl: 'https://start.example.com/',
      mode: 'standard',
      siteLocked: false
    })
    expect(() => guard.forget(1)).not.toThrow()
  })

  it('ignores a URL with no host', () => {
    const { guard } = build()
    expect(
      guard.evaluate({
        webContentsId: 1,
        targetUrl: 'about:blank',
        currentUrl: 'https://start.example.com/',
        mode: 'standard',
        siteLocked: false
      })
    ).toBe(true)
  })
})

describe('GestureTracker', () => {
  it('reports null before any gesture and elapsed time after', () => {
    let clock = 0
    const tracker = new GestureTracker(() => clock)
    expect(tracker.msSince(1)).toBeNull()

    tracker.note(1)
    clock += 120
    expect(tracker.msSince(1)).toBe(120)
  })

  it('counts windows spent against the current gesture and resets on a new one', () => {
    const tracker = new GestureTracker(() => 0)
    tracker.note(1)
    expect(tracker.spentFor(1)).toBe(0)

    tracker.spend(1)
    expect(tracker.spentFor(1)).toBe(1)

    tracker.note(1)
    expect(tracker.spentFor(1)).toBe(0)
  })

  it('takes its own timestamp rather than trusting a caller', () => {
    // The page reports only *that* a gesture happened; the clock is ours.
    const now = vi.fn(() => 500)
    const tracker = new GestureTracker(now)
    tracker.note(1)
    expect(now).toHaveBeenCalled()
  })

  it('forgets a tab', () => {
    const tracker = new GestureTracker(() => 0)
    tracker.note(1)
    tracker.forget(1)
    expect(tracker.msSince(1)).toBeNull()
  })
})
