import { describe, expect, it } from 'vitest'
import { mediaHeaders, refererFor } from './requestHeaders'

const page = {
  referer: 'https://www.youtube.com/watch?v=abc',
  origin: 'https://www.youtube.com',
  userAgent: 'Mozilla/5.0 Slash'
}

const CDN = 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=18'

describe('refererFor', () => {
  it('trims a cross-origin referrer to the origin, as Chromium does', () => {
    // Not politeness — Chromium's network service verifies the referrer against
    // strict-origin-when-cross-origin and CANCELS the request when it does not
    // match, with ERR_BLOCKED_BY_CLIENT. A path here means the server never
    // sees the request at all.
    expect(refererFor(page.referer, page.origin, CDN)).toBe('https://www.youtube.com/')
  })

  it('keeps the full URL when the media is on the page’s own origin', () => {
    expect(refererFor(page.referer, page.origin, 'https://www.youtube.com/a/b.m3u8')).toBe(
      'https://www.youtube.com/watch?v=abc'
    )
  })

  it('sends nothing when https would leak into http', () => {
    expect(refererFor(page.referer, page.origin, 'http://cdn.example/a.mp4')).toBeNull()
  })

  it('sends nothing rather than throwing on an address it cannot parse', () => {
    expect(refererFor('not a url', 'not an origin', CDN)).toBeNull()
  })
})

describe('mediaHeaders', () => {
  it('identifies the browser and the site the media belongs to', () => {
    const headers = mediaHeaders(page, CDN)
    expect(headers['Referer']).toBe('https://www.youtube.com/')
    expect(headers['Origin']).toBe('https://www.youtube.com')
    expect(headers['User-Agent']).toBe('Mozilla/5.0 Slash')
  })

  it('never sends a Sec-Fetch header, because Chromium refuses the request', () => {
    // Not a style rule. These are forbidden header names; a net.request
    // carrying one is rejected with ERR_INVALID_ARGUMENT before it leaves the
    // machine, which broke every download that had an origin to send. Measured
    // by SLASH_MEDIA_ACCESS_PROBE, not reasoned about.
    const headers = mediaHeaders(page, CDN)
    expect(Object.keys(headers).some((name) => /^sec-/i.test(name))).toBe(false)
  })

  it('omits what it does not know rather than inventing it', () => {
    // A download from an internal page has no honest referrer, and a made-up
    // one is worse than none: it is a claim about where the user was.
    const headers = mediaHeaders(undefined, CDN)
    expect(headers['Referer']).toBeUndefined()
    expect(headers['Origin']).toBeUndefined()
    expect(headers['User-Agent']).toBeUndefined()
    expect(headers['Accept']).toBe('*/*')
  })

  it('lets an explicit header win, so Range still reaches the server', () => {
    // The segmented downloader passes Range through this. Silently dropping it
    // would turn every segment into a full-file fetch written at an offset.
    const headers = mediaHeaders(page, CDN, { Range: 'bytes=0-99' })
    expect(headers['Range']).toBe('bytes=0-99')
  })
})
