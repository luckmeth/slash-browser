import { describe, it, expect } from 'vitest'
import { buildTrustReport, trustSummary, type TrustSignals } from './siteTrust'

const signals = (over: Partial<TrustSignals> = {}): TrustSignals => ({
  url: 'https://example.com/page',
  blocked: { ads: 0, trackers: 0, popups: 0, redirects: 0 },
  siteAllowed: false,
  blockingEnabled: true,
  redirectHops: 0,
  redirectThroughTracker: false,
  grants: [],
  denied: [],
  flaggedDownloads: 0,
  ...over
})

const rowFor = (id: string, over: Partial<TrustSignals> = {}) =>
  buildTrustReport(signals(over)).find((row) => row.id === id)

describe('buildTrustReport', () => {
  it('explains every row it produces', () => {
    // A finding with no explanation is the thing this view exists to avoid.
    const rows = buildTrustReport(
      signals({
        blocked: { ads: 3, trackers: 9, popups: 1, redirects: 0 },
        redirectHops: 2,
        grants: [{ kind: 'camera', policy: 'always-allow', expiresAt: null }],
        denied: ['microphone'],
        flaggedDownloads: 1
      })
    )
    expect(rows.length).toBeGreaterThan(4)
    for (const row of rows) {
      expect(row.explanation.length, row.id).toBeGreaterThan(30)
    }
  })

  it('never produces a score', () => {
    const rows = buildTrustReport(signals({ blocked: { ads: 5, trackers: 5, popups: 0, redirects: 0 } }))
    const text = rows.map((row) => `${row.value} ${row.explanation}`).join(' ')
    expect(text).not.toMatch(/\b\d+\s*\/\s*10\b|score|rating|grade [A-F]\b/i)
  })

  it('does not call an encrypted connection secure', () => {
    // "Secure" is the word browsers used here for years, and it taught people
    // that a padlock meant a site could be trusted.
    const row = rowFor('https')
    expect(row?.value).toBe('Encrypted (HTTPS)')
    expect(row?.explanation).toContain('says nothing about who runs the site')
  })

  it('flags an unencrypted connection and says what it costs', () => {
    const row = rowFor('https', { url: 'http://example.com/' })
    expect(row?.tone).toBe('caution')
    expect(row?.explanation).toContain('anything you type')
  })

  it('treats an internal page as neither', () => {
    const row = rowFor('https', { url: 'slash://settings' })
    expect(row?.tone).toBe('neutral')
    expect(row?.value).toBe('Local page')
  })

  it('counts what was blocked and says how', () => {
    const row = rowFor('blocking', {
      blocked: { ads: 2, trackers: 10, popups: 1, redirects: 0 }
    })
    expect(row?.value).toBe('13 blocked')
    expect(row?.explanation).toContain('2 adverts')
    expect(row?.explanation).toContain('10 trackers')
    expect(row?.tone).toBe('good')
  })

  it('does not read "nothing blocked" as "nothing to block"', () => {
    // The honest reading is that nothing matched, which is not the same as the
    // page being clean — the lists do not know everything.
    const row = rowFor('blocking')
    expect(row?.tone).toBe('neutral')
    expect(row?.explanation).toContain('ones the lists do not know')
  })

  it('says when blocking is off globally rather than blaming the site', () => {
    const row = rowFor('blocking', { blockingEnabled: false })
    expect(row?.tone).toBe('caution')
    expect(row?.explanation).toContain('not something about this site')
  })

  it('says when the user exempted this site', () => {
    const row = rowFor('blocking', { siteAllowed: true })
    expect(row?.tone).toBe('caution')
    expect(row?.explanation).toContain('You exempted')
  })

  it('treats an ordinary redirect as ordinary', () => {
    const row = rowFor('redirects', { redirectHops: 1 })
    expect(row?.tone).toBe('neutral')
    expect(row?.explanation).toContain('ordinary for links and sign-ins')
  })

  it('raises a redirect that went through a known tracker', () => {
    const row = rowFor('redirects', { redirectHops: 2, redirectThroughTracker: true })
    expect(row?.tone).toBe('caution')
    expect(row?.explanation).toContain('tracker')
  })

  it('reports no permissions as a good thing, precisely', () => {
    const row = rowFor('permissions')
    expect(row?.tone).toBe('good')
    expect(row?.value).toBe('None granted')
  })

  it('raises a sensitive grant and says how to withdraw it', () => {
    const row = rowFor('permissions', {
      grants: [{ kind: 'camera', policy: 'always-allow', expiresAt: null }]
    })
    expect(row?.tone).toBe('caution')
    expect(row?.explanation).toContain('withdrawn')
    // The reload caveat matters: Chromium caches some grants renderer-side.
    expect(row?.explanation).toContain('reload')
  })

  it('does not raise an ordinary grant to a caution', () => {
    const row = rowFor('permissions', {
      grants: [{ kind: 'notifications', policy: 'always-allow', expiresAt: null }]
    })
    expect(row?.tone).toBe('neutral')
  })

  it('says a refusal is not permanent', () => {
    const row = rowFor('denied', { denied: ['camera', 'camera', 'microphone'] })
    expect(row?.value).toBe('3 requests')
    // Deduplicated in the sentence, because "camera, camera, microphone" reads
    // as a fault in the browser rather than as a site asking twice.
    expect(row?.explanation).toContain('camera, microphone')
    expect(row?.explanation).toContain('not permanent')
  })

  it('omits the refused row when nothing was refused', () => {
    expect(rowFor('denied')).toBeUndefined()
  })

  it('calls a flagged download a caution rather than a verdict', () => {
    const row = rowFor('downloads', { flaggedDownloads: 2 })
    expect(row?.tone).toBe('caution')
    expect(row?.explanation).toContain('nothing here')
    expect(row?.explanation).toContain('scans a file')
  })
})

describe('trustSummary', () => {
  it('never says a site is safe', () => {
    // No signal here can support that, and a browser that says it teaches
    // somebody to stop checking.
    const summary = trustSummary(buildTrustReport(signals()))
    expect(summary).not.toMatch(/\bsafe\b|\btrustworthy\b|\bsecure\b/i)
    expect(summary).toContain('not a verdict')
  })

  it('labels the blocking row for everything it actually counts', () => {
    // It covers adverts, trackers and pop-ups, so "Trackers" put "11 adverts"
    // under a heading that did not mention adverts.
    const row = buildTrustReport(
      signals({ blocked: { ads: 11, trackers: 0, popups: 0, redirects: 0 } })
    ).find((r) => r.id === 'blocking')
    expect(row?.label).toBe('Ads and trackers')
    expect(row?.explanation).toContain('11 adverts')
  })

  it('names what is worth a look', () => {
    const summary = trustSummary(
      buildTrustReport(signals({ url: 'http://example.com/', flaggedDownloads: 1 }))
    )
    expect(summary).toContain('2 things worth a look')
    expect(summary).toContain('connection')
    expect(summary).toContain('downloads')
  })

  it('says "1 thing", not "1 things"', () => {
    const summary = trustSummary(buildTrustReport(signals({ url: 'http://example.com/' })))
    expect(summary).toContain('1 thing worth a look')
  })
})
