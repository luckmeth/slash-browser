import { describe, it, expect } from 'vitest'
import {
  FILTER_LIST_SOURCES,
  FILTER_REFRESH_INTERVAL_MS,
  isTrustedListUrl,
  looksLikeFilterList,
  shouldRefreshFilterLists
} from './FilterListUpdater'

describe('shouldRefreshFilterLists', () => {
  const base = { enabled: true, lastCheckedAt: 0, now: FILTER_REFRESH_INTERVAL_MS + 1 }

  it('refreshes once the interval has passed', () => {
    expect(shouldRefreshFilterLists(base)).toBe(true)
  })

  it('does nothing when the switch is off', () => {
    expect(shouldRefreshFilterLists({ ...base, enabled: false })).toBe(false)
  })

  it('waits out the interval rather than checking on every launch', () => {
    expect(shouldRefreshFilterLists({ ...base, now: 1 })).toBe(false)
    expect(shouldRefreshFilterLists({ ...base, now: FILTER_REFRESH_INTERVAL_MS - 1 })).toBe(false)
  })

  it('refreshes exactly on the boundary', () => {
    expect(shouldRefreshFilterLists({ ...base, now: FILTER_REFRESH_INTERVAL_MS })).toBe(true)
  })

  it('treats a backwards clock as due rather than as never due', () => {
    // A corrected clock leaves a future `lastCheckedAt`. Reading that as "not
    // yet" would mean lists that can never update again.
    expect(shouldRefreshFilterLists({ ...base, lastCheckedAt: 10_000, now: 5_000 })).toBe(true)
  })

  it('checks every four days, from how often the lists actually move', () => {
    expect(FILTER_REFRESH_INTERVAL_MS).toBe(4 * 24 * 60 * 60 * 1000)
  })
})

describe('isTrustedListUrl', () => {
  it.each([
    'https://easylist.to/easylist/easylist.txt',
    'https://ublockorigin.github.io/uAssets/filters/filters.txt'
  ])('accepts %s', (url) => {
    expect(isTrustedListUrl(url)).toBe(true)
  })

  it.each([
    // The lookalike. A suffix test would accept this and fetch the browser's
    // enforcement rules from somebody else's server.
    'https://easylist.to.evil.test/easylist.txt',
    'https://ublockorigin.github.io.evil.test/filters.txt',
    'https://raw.githubusercontent.com/easylist/easylist/master/easylist.txt',
    // Plain http, on a file that decides what the browser blocks.
    'http://easylist.to/easylist/easylist.txt',
    'not a url',
    ''
  ])('refuses %s', (url) => {
    expect(isTrustedListUrl(url)).toBe(false)
  })

  it('every shipped source passes its own test', () => {
    for (const source of FILTER_LIST_SOURCES) {
      expect(isTrustedListUrl(source.url)).toBe(true)
    }
  })
})

describe('looksLikeFilterList', () => {
  const realList = ['[Adblock Plus 2.0]', '! Title: EasyList', '! Expires: 1 day']
    .concat(Array.from({ length: 300 }, (_, index) => `||ads${index}.example.com^`))
    .join('\n')

  it('accepts a real list', () => {
    expect(looksLikeFilterList(realList)).toBe(true)
  })

  it('accepts one that opens with a comment rather than a header', () => {
    const body = ['! Title: uBlock filters', '! Expires: 4 days']
      .concat(Array.from({ length: 300 }, (_, index) => `||track${index}.example.com^`))
      .join('\n')
    expect(looksLikeFilterList(body)).toBe(true)
  })

  it('refuses an HTML error page served with a 200', () => {
    // The failure this exists for. Writing this over a working list would
    // disable blocking on the next compile, with the right filename and the
    // wrong contents, and nothing would report it.
    const page = '<!DOCTYPE html>\n<html><body>502 Bad Gateway</body></html>\n'.padEnd(5000, ' ')
    expect(looksLikeFilterList(page)).toBe(false)
  })

  it('refuses a captive portal login page', () => {
    const page = ('<html><head><title>Sign in to WiFi</title></head>' + 'x'.repeat(4000)) + '</html>'
    expect(looksLikeFilterList(page)).toBe(false)
  })

  it('refuses a truncated download that stopped after the header', () => {
    const truncated = '[Adblock Plus 2.0]\n! Title: EasyList\n'.padEnd(2000, '\n')
    expect(looksLikeFilterList(truncated)).toBe(false)
  })

  it('refuses an empty or tiny body', () => {
    expect(looksLikeFilterList('')).toBe(false)
    expect(looksLikeFilterList('[Adblock Plus 2.0]')).toBe(false)
  })

  it('refuses JSON, which is what an API error usually is', () => {
    const json = JSON.stringify({ error: 'not found' }).padEnd(2000, ' ')
    expect(looksLikeFilterList(json)).toBe(false)
  })
})

describe('FILTER_LIST_SOURCES', () => {
  it('keeps the bundled filenames, so the compile stamp still works', () => {
    // `fingerprintLists` keys the compiled cache on name + byte length. A
    // refreshed list must land under the same name or the engine would compile
    // a directory holding both copies.
    const names = FILTER_LIST_SOURCES.map((source) => source.file)
    expect(names).toEqual([
      'easylist.txt',
      'easyprivacy.txt',
      'ublock-filters.txt',
      'ublock-badware.txt',
      'ublock-privacy.txt'
    ])
  })

  it('names every list, because Settings shows what it fetched', () => {
    for (const source of FILTER_LIST_SOURCES) {
      expect(source.name.length).toBeGreaterThan(0)
    }
  })
})
