import { describe, it, expect } from 'vitest'
import { hintedSize, pickFavicon } from './favicon'

describe('hintedSize', () => {
  it.each([
    ['https://x.test/favicon-32x32.png', 32],
    ['https://x.test/icons/180x180.png', 180],
    ['https://x.test/apple-touch-icon-180.png', 180],
    ['https://x.test/icon-192.png', 192],
    ['https://x.test/favicon-32x32.png?v=3', 32]
  ])('reads %s as %i', (url, size) => {
    expect(hintedSize(url)).toBe(size)
  })

  it.each([
    // A hash is not a size, and a mismatched pair is not a square icon.
    ['https://x.test/a1b2c3d4.png', 0],
    ['https://x.test/icon-16x32.png', 0],
    ['https://x.test/favicon.ico', 0],
    ['https://x.test/logo.svg', 0]
  ])('reads no size from %s', (url, size) => {
    expect(hintedSize(url)).toBe(size)
  })
})

describe('pickFavicon', () => {
  it('returns null when a page declared nothing', () => {
    expect(pickFavicon([])).toBeNull()
  })

  it('takes the only candidate, whatever it is', () => {
    expect(pickFavicon(['https://x.test/favicon.ico'])).toBe('https://x.test/favicon.ico')
  })

  it('prefers a larger declared size over the legacy default', () => {
    // The whole point. Sites list /favicon.ico first for historical reasons, so
    // taking the first entry took the 16x16 almost every time.
    expect(
      pickFavicon(['https://x.test/favicon.ico', 'https://x.test/favicon-32x32.png'])
    ).toBe('https://x.test/favicon-32x32.png')
  })

  it('prefers SVG over any bitmap, however large', () => {
    expect(
      pickFavicon([
        'https://x.test/favicon.ico',
        'https://x.test/icon-512x512.png',
        'https://x.test/icon.svg'
      ])
    ).toBe('https://x.test/icon.svg')
  })

  it('prefers an already-inlined icon over everything', () => {
    // No second request at all, and it is what the page chose to embed.
    expect(pickFavicon(['https://x.test/icon.svg', 'data:image/png;base64,AAAA'])).toBe(
      'data:image/png;base64,AAAA'
    )
  })

  it('prefers the largest of several sizes', () => {
    expect(
      pickFavicon([
        'https://x.test/favicon-16x16.png',
        'https://x.test/favicon-192x192.png',
        'https://x.test/favicon-32x32.png'
      ])
    ).toBe('https://x.test/favicon-192x192.png')
  })

  it('takes apple-touch-icon over an unhinted icon', () => {
    expect(
      pickFavicon(['https://x.test/icon.png', 'https://x.test/apple-touch-icon.png'])
    ).toBe('https://x.test/apple-touch-icon.png')
  })

  it('keeps the page ordering when nothing separates two candidates', () => {
    expect(pickFavicon(['https://x.test/a.png', 'https://x.test/b.png'])).toBe(
      'https://x.test/a.png'
    )
  })

  it('ignores empty entries rather than returning one', () => {
    expect(pickFavicon(['', 'https://x.test/favicon.ico'])).toBe('https://x.test/favicon.ico')
  })

  it('never reaches the network', () => {
    // Stated as a test because it is the reason this is URL-ranking rather than
    // a favicon service: a service would sharpen these too, and would send one
    // hostname at a time to a third party for every site somebody visits.
    const before = globalThis.fetch
    let called = false
    globalThis.fetch = (() => {
      called = true
      throw new Error('pickFavicon must not fetch')
    }) as typeof fetch
    pickFavicon(['https://x.test/favicon.ico', 'https://x.test/icon-192.png'])
    globalThis.fetch = before
    expect(called).toBe(false)
  })
})
