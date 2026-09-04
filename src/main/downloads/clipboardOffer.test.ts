import { describe, expect, it } from 'vitest'
import { readOffer } from './clipboardOffer'

/**
 * These tests are the privacy boundary, not a convenience check.
 *
 * `readOffer` decides whether a piece of the user's clipboard is looked at any
 * further. Everything it rejects is discarded before anything else in the
 * browser sees it, so "does it reject a password" is a more important question
 * here than "does it accept a PDF".
 */
describe('readOffer — what it refuses to treat as a download', () => {
  it('ignores anything that is not a single bare URL', () => {
    // Copied prose containing a link is not somebody asking to download it.
    // Without this the feature would fire on nearly every copy from a web page.
    expect(readOffer('see https://a.test/x.pdf for details')).toBeNull()
    expect(readOffer('https://a.test/x.pdf https://a.test/y.pdf')).toBeNull()
  })

  it('ignores a password, which is the thing most likely to be on a clipboard', () => {
    expect(readOffer('hunter2')).toBeNull()
    expect(readOffer('correct-horse-battery-staple')).toBeNull()
    expect(readOffer('Tr0ub4dor&3')).toBeNull()
  })

  it('ignores an ordinary page address', () => {
    // Otherwise it would offer constantly while browsing, which trains people
    // to dismiss it without reading.
    expect(readOffer('https://news.test/article/why-things-happen')).toBeNull()
    expect(readOffer('https://a.test/')).toBeNull()
  })

  it.each(['file:///etc/passwd', 'data:text/plain,x', 'javascript:alert(1)', 'ftp://a.test/x.zip'])(
    'ignores the %s scheme',
    (value) => {
      expect(readOffer(value)).toBeNull()
    }
  )

  it('ignores anything long enough to be a document rather than a link', () => {
    expect(readOffer(`https://a.test/${'x'.repeat(4000)}.pdf`)).toBeNull()
  })

  it('ignores empty and whitespace clipboards', () => {
    expect(readOffer('')).toBeNull()
    expect(readOffer('   ')).toBeNull()
  })

  it('never throws on whatever happens to be copied', () => {
    expect(() => readOffer('https://[[[not-a-url')).not.toThrow()
    expect(readOffer('https://[[[not-a-url')).toBeNull()
  })
})

describe('readOffer — what it does offer', () => {
  it.each([
    ['https://a.test/report.pdf', 'report.pdf'],
    ['https://a.test/files/archive.zip', 'archive.zip'],
    ['https://a.test/video.mp4', 'video.mp4'],
    ['https://a.test/setup.exe', 'setup.exe']
  ])('offers %s as %s', (url, filename) => {
    expect(readOffer(url)).toEqual({ url, filename })
  })

  it('trims surrounding whitespace, which copying nearly always adds', () => {
    expect(readOffer('  https://a.test/x.pdf\n')?.url).toBe('https://a.test/x.pdf')
  })

  it('decodes a percent-encoded filename for the offer text', () => {
    // The offer names the file, and "My%20Report.pdf" is not what it is called.
    expect(readOffer('https://a.test/My%20Report.pdf')?.filename).toBe('My Report.pdf')
  })

  it('keeps the query string, which often carries the token', () => {
    const offer = readOffer('https://a.test/get.zip?token=abc')
    expect(offer?.url).toBe('https://a.test/get.zip?token=abc')
  })
})
