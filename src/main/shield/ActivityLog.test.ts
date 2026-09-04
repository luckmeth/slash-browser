import { describe, it, expect } from 'vitest'
import { ActivityLog, MAX_ENTRIES_PER_TAB } from './ActivityLog'

describe('ActivityLog', () => {
  it('counts each category separately and totals them', () => {
    const log = new ActivityLog(() => 1000)
    log.record(1, 'ad', 'doubleclick.net', 'news.example.com')
    log.record(1, 'ad', 'adnxs.com', 'news.example.com')
    log.record(1, 'tracker', 'hotjar.com', 'news.example.com')
    log.record(1, 'popup', 'ads.example.net', 'news.example.com')
    log.record(1, 'redirect', 'spam.example.net', 'news.example.com')

    expect(log.countsFor(1)).toEqual({ ads: 2, trackers: 1, popups: 1, redirects: 1 })
    // The dashboard's split must always sum to the number on the button.
    expect(log.totalFor(1)).toBe(5)
  })

  it('keeps tabs apart', () => {
    const log = new ActivityLog(() => 1000)
    log.record(1, 'ad', 'a.example.net', 'one.example.com')
    log.record(2, 'tracker', 'b.example.net', 'two.example.com')

    expect(log.totalFor(1)).toBe(1)
    expect(log.countsFor(2)).toEqual({ ads: 0, trackers: 1, popups: 0, redirects: 0 })
  })

  it('does not count a refused malicious navigation as a blocked resource', () => {
    // It is a blocked *page*, which gets its own notice rather than a counter.
    const log = new ActivityLog(() => 1000)
    log.record(1, 'malicious', 'bad.example.test', 'bad.example.test')
    expect(log.totalFor(1)).toBe(0)
  })

  it('returns recent entries newest first', () => {
    const log = new ActivityLog(() => 1000)
    log.record(1, 'ad', 'first.example.net', 'page.example.com')
    log.record(1, 'ad', 'second.example.net', 'page.example.com')

    const recent = log.entriesFor(1)
    expect(recent[0]?.host).toBe('second.example.net')
    expect(recent[1]?.host).toBe('first.example.net')
  })

  it('bounds the entry list without losing the counts', () => {
    // A tab left on an ad-heavy site all day must not grow without limit, but
    // "3,412 blocked" has to stay true.
    const log = new ActivityLog(() => 1000)
    const total = MAX_ENTRIES_PER_TAB + 50
    for (let i = 0; i < total; i += 1) {
      log.record(1, 'ad', `host${i}.example.net`, 'page.example.com')
    }

    expect(log.totalFor(1)).toBe(total)
    expect(log.entriesFor(1, 1000).length).toBe(MAX_ENTRIES_PER_TAB)
    // The oldest are the ones dropped.
    expect(log.entriesFor(1, 1000).at(-1)?.host).toBe(`host${total - MAX_ENTRIES_PER_TAB}.example.net`)
  })

  it('records only hosts, never full URLs', () => {
    // The type enforces this at call sites; this pins the stored shape too.
    const log = new ActivityLog(() => 1000)
    log.record(1, 'tracker', 'analytics.example.net', 'page.example.com')
    const entry = log.entriesFor(1)[0]
    expect(entry?.host).toBe('analytics.example.net')
    expect(Object.keys(entry ?? {}).sort()).toEqual(['at', 'category', 'host', 'id', 'pageHost'])
  })

  it('resets a tab on navigation and reports whether there was anything', () => {
    const log = new ActivityLog(() => 1000)
    log.record(1, 'ad', 'a.example.net', 'page.example.com')

    expect(log.reset(1)).toBe(true)
    expect(log.totalFor(1)).toBe(0)
    expect(log.reset(1)).toBe(false)
  })

  it('clears everything', () => {
    const log = new ActivityLog(() => 1000)
    log.record(1, 'ad', 'a.example.net', 'one.example.com')
    log.record(2, 'ad', 'b.example.net', 'two.example.com')

    log.clearAll()
    expect(log.totalFor(1)).toBe(0)
    expect(log.totalFor(2)).toBe(0)
  })
})
