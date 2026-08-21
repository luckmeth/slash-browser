import { describe, it, expect } from 'vitest'
import { gapsFor } from './manifestGaps'

const capabilities = (manifest: unknown): string[] =>
  gapsFor(manifest).map((gap) => gap.capability)

describe('gapsFor', () => {
  it('reports nothing for an extension asking only for what works', () => {
    // A content-script extension with ordinary permissions genuinely does run,
    // and saying otherwise would put people off loading the ones that work.
    expect(
      gapsFor({
        manifest_version: 2,
        permissions: ['storage', 'tabs', 'activeTab']
      })
    ).toEqual([])
  })

  it('flags native messaging, which is what breaks download managers', () => {
    const gaps = gapsFor({ manifest_version: 2, permissions: ['nativeMessaging'] })
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.capability).toBe('nativeMessaging')
    // The detail has to say the consequence, not just name the API.
    expect(gaps[0]!.detail).toMatch(/desktop program/i)
  })

  it('flags blocking webRequest, which is what breaks content blockers', () => {
    expect(capabilities({ manifest_version: 2, permissions: ['webRequestBlocking'] })).toContain(
      'webRequestBlocking'
    )
  })

  it('flags declarativeNetRequest in both spellings', () => {
    expect(capabilities({ permissions: ['declarativeNetRequest'] })).toContain(
      'declarativeNetRequest'
    )
    expect(capabilities({ permissions: ['declarativeNetRequestWithHostAccess'] })).toContain(
      'declarativeNetRequest'
    )
  })

  it('flags the downloads API and points at the built-in manager', () => {
    const gaps = gapsFor({ permissions: ['downloads'] })
    expect(gaps[0]!.detail).toMatch(/download manager/i)
  })

  it('reads optional permissions too', () => {
    // An extension can request these later; the user should be warned up front
    // rather than when the feature silently fails.
    expect(capabilities({ optional_permissions: ['nativeMessaging'] })).toContain('nativeMessaging')
  })

  it('cautions about MV3 service workers without calling them broken', () => {
    const gaps = gapsFor({
      manifest_version: 3,
      background: { service_worker: 'sw.js' }
    })
    expect(gaps.map((gap) => gap.capability)).toContain('service worker background')
    expect(gaps[0]!.detail).toMatch(/partly supported/i)
  })

  it('does not caution about MV3 without a service worker', () => {
    expect(capabilities({ manifest_version: 3, background: { page: 'bg.html' } })).toEqual([])
  })

  it('does not caution about a service worker under MV2', () => {
    expect(capabilities({ manifest_version: 2, background: { service_worker: 'sw.js' } })).toEqual(
      []
    )
  })

  it('survives a manifest that is missing, malformed or hostile', () => {
    // A manifest that will not parse arrives here as null, and a folder can
    // contain anything at all. None of it may throw.
    expect(gapsFor(null)).toEqual([])
    expect(gapsFor(undefined)).toEqual([])
    expect(gapsFor('not an object')).toEqual([])
    expect(gapsFor({ permissions: 'not-an-array' })).toEqual([])
    expect(gapsFor({ permissions: [1, 2, null] })).toEqual([])
    expect(() => gapsFor({ background: null })).not.toThrow()
  })

  it('reports several gaps at once for an extension needing all of them', () => {
    const gaps = capabilities({
      manifest_version: 3,
      background: { service_worker: 'sw.js' },
      permissions: ['nativeMessaging', 'downloads', 'declarativeNetRequest']
    })
    expect(gaps).toHaveLength(4)
  })
})
