import { describe, it, expect } from 'vitest'
import {
  chromeTimeToUnixMs,
  countLinks,
  isImportableUrl,
  readBookmarkRoots
} from './chromiumData'

/**
 * 2021-01-01T00:00:00Z as a Chromium FILETIME, in microseconds.
 * Derived as `(Date.UTC(2021, 0, 1) + 11_644_473_600_000) * 1000`.
 */
const CHROME_2021 = '13253932800000000'

describe('chromeTimeToUnixMs', () => {
  it('converts from the 1601 epoch', () => {
    const converted = chromeTimeToUnixMs(CHROME_2021)
    expect(new Date(converted!).toISOString()).toBe('2021-01-01T00:00:00.000Z')
  })

  it('accepts the value as a number as well as a string', () => {
    expect(chromeTimeToUnixMs(Number(CHROME_2021))).toBe(chromeTimeToUnixMs(CHROME_2021))
  })

  it('rejects values that are not timestamps', () => {
    // Read naively these become 1970 or earlier, which sorts the whole import to
    // the bottom of history where nobody will find it.
    expect(chromeTimeToUnixMs(0)).toBeNull()
    expect(chromeTimeToUnixMs('0')).toBeNull()
    expect(chromeTimeToUnixMs(-1)).toBeNull()
    expect(chromeTimeToUnixMs('')).toBeNull()
    expect(chromeTimeToUnixMs(undefined)).toBeNull()
    expect(chromeTimeToUnixMs('not a number')).toBeNull()
  })

  it('rejects a Unix timestamp fed in by mistake', () => {
    // 1.7e12 ms as microseconds-since-1601 lands well before 1970.
    expect(chromeTimeToUnixMs(1_700_000_000_000)).toBeNull()
  })

  it('rejects an absurd future date', () => {
    expect(chromeTimeToUnixMs('99999999999999999999')).toBeNull()
  })
})

describe('isImportableUrl', () => {
  it('takes real web addresses', () => {
    expect(isImportableUrl('https://example.com')).toBe(true)
    expect(isImportableUrl('http://example.com')).toBe(true)
    expect(isImportableUrl('file:///C:/notes.txt')).toBe(true)
  })

  it('refuses the other browser’s internal pages', () => {
    // These cannot open here, so importing them creates bookmarks that can only
    // ever fail.
    expect(isImportableUrl('chrome://settings')).toBe(false)
    expect(isImportableUrl('edge://favorites')).toBe(false)
    expect(isImportableUrl('about:blank')).toBe(false)
  })

  it('refuses bookmarklets', () => {
    // Importing one would put someone else's script one click away in our chrome.
    expect(isImportableUrl('javascript:alert(1)')).toBe(false)
    expect(isImportableUrl('JavaScript:alert(1)')).toBe(false)
    expect(isImportableUrl('data:text/html,<h1>hi')).toBe(false)
  })
})

describe('readBookmarkRoots', () => {
  const file = {
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bookmarks bar',
        children: [
          { type: 'url', name: 'Example', url: 'https://example.com', date_added: CHROME_2021 },
          {
            type: 'folder',
            name: 'Work',
            children: [{ type: 'url', name: 'Docs', url: 'https://docs.example.com' }]
          }
        ]
      },
      other: {
        type: 'folder',
        name: 'Other bookmarks',
        children: [{ type: 'url', name: 'Blog', url: 'https://blog.example.com' }]
      },
      synced: { type: 'folder', name: 'Mobile bookmarks', children: [] }
    }
  }

  it('keeps the folder structure rather than flattening it', () => {
    const roots = readBookmarkRoots(file)
    expect(roots.map((root) => root.title)).toEqual(['Bookmarks bar', 'Other bookmarks'])

    const bar = roots[0]!
    expect(bar.url).toBeNull()
    expect(bar.children).toHaveLength(2)
    expect(bar.children[1]!.title).toBe('Work')
    expect(bar.children[1]!.children[0]!.url).toBe('https://docs.example.com')
  })

  it('drops empty roots instead of creating empty folders', () => {
    // "Mobile bookmarks" has no links; importing it would add a folder that
    // never contains anything.
    expect(readBookmarkRoots(file).some((root) => root.title === 'Mobile bookmarks')).toBe(false)
  })

  it('carries the date each bookmark was added', () => {
    const example = readBookmarkRoots(file)[0]!.children[0]!
    expect(new Date(example.addedAt!).toISOString()).toBe('2021-01-01T00:00:00.000Z')
  })

  it('leaves the date null when the file does not have one', () => {
    const docs = readBookmarkRoots(file)[0]!.children[1]!.children[0]!
    expect(docs.addedAt).toBeNull()
  })

  it('skips unimportable links but keeps their siblings', () => {
    const roots = readBookmarkRoots({
      roots: {
        bookmark_bar: {
          children: [
            { type: 'url', name: 'Bad', url: 'javascript:alert(1)' },
            { type: 'url', name: 'Internal', url: 'chrome://settings' },
            { type: 'url', name: 'Good', url: 'https://example.com' }
          ]
        }
      }
    })
    expect(countLinks(roots[0]!)).toBe(1)
    expect(roots[0]!.children[0]!.title).toBe('Good')
  })

  it('survives a file that is not a bookmarks file at all', () => {
    // It is JSON in a directory the user can edit, written by a program we do
    // not control. Every one of these must be a no-op, not a crash.
    expect(readBookmarkRoots(null)).toEqual([])
    expect(readBookmarkRoots({})).toEqual([])
    expect(readBookmarkRoots({ roots: 'nonsense' })).toEqual([])
    expect(readBookmarkRoots({ roots: { bookmark_bar: 42 } })).toEqual([])
    expect(readBookmarkRoots([1, 2, 3])).toEqual([])
  })

  it('survives children that are not objects', () => {
    const roots = readBookmarkRoots({
      roots: {
        bookmark_bar: {
          children: [null, 'x', 7, { type: 'url', url: 'https://example.com', name: 'Fine' }]
        }
      }
    })
    expect(countLinks(roots[0]!)).toBe(1)
  })

  it('falls back to the URL when a bookmark has no name', () => {
    const roots = readBookmarkRoots({
      roots: { bookmark_bar: { children: [{ type: 'url', url: 'https://example.com' }] } }
    })
    expect(roots[0]!.children[0]!.title).toBe('https://example.com')
  })
})
