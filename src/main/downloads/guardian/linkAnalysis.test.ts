import { describe, it, expect } from 'vitest'
import {
  analyseLink,
  extensionOf,
  looksLikeFile,
  rankCandidates,
  registrableDomain,
  summarise
} from './linkAnalysis'

const context = {
  pageUrl: 'https://www.example.com/downloads',
  isKnownAdHost: (host: string) => host.includes('adnetwork')
}

const link = (over: Partial<Parameters<typeof analyseLink>[0]> = {}) =>
  analyseLink({ url: 'https://example.com/app.exe', label: 'Download', insideAdMarkup: false, ...over }, context)

describe('registrableDomain', () => {
  it('reduces a host to the domain its operator is identified by', () => {
    expect(registrableDomain('cdn.example.com')).toBe('example.com')
    expect(registrableDomain('www.example.com')).toBe('example.com')
    expect(registrableDomain('example.com')).toBe('example.com')
  })

  it('handles multi-part public suffixes', () => {
    // Getting this wrong would call downloads.bbc.co.uk third-party on bbc.co.uk.
    expect(registrableDomain('downloads.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrableDomain('shop.company.com.au')).toBe('company.com.au')
  })

  it('does not treat a lookalike as the same domain', () => {
    expect(registrableDomain('example-downloads.com')).not.toBe(registrableDomain('example.com'))
  })
})

describe('extensionOf and looksLikeFile', () => {
  it('reads the extension from the path, ignoring the query', () => {
    expect(extensionOf('https://example.com/a/b/setup.EXE?token=1')).toBe('exe')
    expect(extensionOf('https://example.com/page')).toBeNull()
  })

  it('recognises files rather than pages', () => {
    expect(looksLikeFile('https://example.com/app.dmg')).toBe(true)
    expect(looksLikeFile('https://example.com/doc.pdf')).toBe(true)
    expect(looksLikeFile('https://example.com/about')).toBe(false)
    expect(looksLikeFile('https://example.com/index.html')).toBe(false)
  })
})

describe('analyseLink', () => {
  it('calls a same-site file likely official', () => {
    const result = link()
    expect(result?.verdict).toBe('likely-official')
    expect(result?.reasons[0]).toContain('same site')
  })

  it('calls an off-site file third-party without condemning it', () => {
    const result = link({ url: 'https://mirror.other.com/app.exe' })
    expect(result?.verdict).toBe('third-party')
    // A CDN is normal. The wording must not imply wrongdoing.
    expect(result?.reasons.join(' ')).toContain('not this site')
    expect(result?.reasons.join(' ')).toContain('worth confirming')
  })

  it('flags advertising markup above everything else', () => {
    // A plausible extension on the same site must not launder an ad slot.
    const result = link({ insideAdMarkup: true })
    expect(result?.verdict).toBe('advertisement')
    expect(result?.reasons[0]).toContain('advertising markup')
  })

  it('flags a known ad host', () => {
    const result = link({ url: 'https://tracker.adnetwork.io/click?to=x' })
    expect(result?.verdict).toBe('advertisement')
  })

  it('flags the classic deceptive download button', () => {
    // Says Download, is not a file, leaves the site. Each alone is ordinary.
    const result = link({ url: 'https://elsewhere.net/landing', label: 'DOWNLOAD NOW' })
    expect(result?.verdict).toBe('suspicious')
    expect(result?.reasons[0]).toContain('another site')
  })

  it('does not flag an off-site page link that makes no download claim', () => {
    // Ordinary outbound links are not this feature's business.
    expect(link({ url: 'https://elsewhere.net/about', label: 'About us' })).toBeNull()
  })

  it('warns that executables run code', () => {
    expect(link()?.reasons.join(' ')).toContain('runs code when opened')
    expect(link({ url: 'https://example.com/notes.pdf' })?.reasons.join(' ')).not.toContain(
      'runs code'
    )
  })

  it('never claims a file is safe', () => {
    for (const candidate of [
      link(),
      link({ url: 'https://mirror.other.com/app.exe' }),
      link({ insideAdMarkup: true })
    ]) {
      const text = candidate!.reasons.join(' ').toLowerCase()
      expect(text).not.toContain('is safe')
      expect(text).not.toContain('guaranteed')
      expect(text).not.toContain('verified safe')
    }
  })

  it('ignores non-http schemes', () => {
    expect(link({ url: 'javascript:void(0)', label: 'Download' })).toBeNull()
    expect(link({ url: 'magnet:?xt=urn:btih:abc', label: 'Download' })).toBeNull()
  })

  it('falls back to the host when a link has no visible text', () => {
    expect(link({ label: '   ' })?.label).toBe('example.com')
  })
})

describe('rankCandidates', () => {
  it('puts the likely-official download first', () => {
    const candidates = [
      link({ url: 'https://ads.adnetwork.io/x.exe' })!,
      link({ url: 'https://other.com/app.exe' })!,
      link()!
    ]
    expect(rankCandidates(candidates).map((c) => c.verdict)).toEqual([
      'likely-official',
      'third-party',
      'advertisement'
    ])
  })

  it('collapses the same URL linked twice', () => {
    // A button and a text link to one installer is one download, not two.
    const twice = [link()!, link({ label: 'Get it here' })!]
    expect(rankCandidates(twice)).toHaveLength(1)
  })
})

describe('summarise', () => {
  it('leads with the count, because the count is the warning', () => {
    const many = [
      link()!,
      link({ url: 'https://a.adnetwork.io/x.exe' })!,
      link({ url: 'https://b.com/y.exe' })!
    ]
    const text = summarise(many)!
    expect(text.startsWith('There are 3 download links')).toBe(true)
    expect(text).toContain('review carefully')
  })

  it('handles one link and none', () => {
    expect(summarise([link()!])).toContain('There is 1 download link')
    expect(summarise([])).toBe('No download links were found on this page.')
  })
})
