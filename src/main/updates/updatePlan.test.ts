import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  normaliseSha512,
  packageFileName,
  packageHostAllowed,
  planInstall,
  MAX_PACKAGE_BYTES
} from './updatePlan'

const FEED = 'https://ops.slash.test/api/updates/latest'
const HEX = createHash('sha512').update('slash').digest('hex')
const B64 = createHash('sha512').update('slash').digest('base64')

describe('where a package may come from', () => {
  it('accepts the host that served the feed', () => {
    expect(packageHostAllowed('https://ops.slash.test/downloads/Slash.exe', FEED)).toBe(true)
  })

  it('accepts a GitHub release asset', () => {
    expect(
      packageHostAllowed('https://github.com/slash/browser/releases/download/v1/Slash.exe', FEED)
    ).toBe(true)
    expect(packageHostAllowed('https://objects.githubusercontent.com/x/y.exe', FEED)).toBe(true)
  })

  it('refuses any other host, however plausible', () => {
    // A feed that can name an arbitrary host is a feed that can make this
    // browser fetch and run an executable from anywhere.
    expect(packageHostAllowed('https://cdn.example.net/Slash.exe', FEED)).toBe(false)
    expect(packageHostAllowed('https://github.com.evil.test/x/Slash.exe', FEED)).toBe(false)
    expect(packageHostAllowed('https://notgithub.com/releases/download/v1/x.exe', FEED)).toBe(false)
  })

  it('refuses plain http, even on the right host', () => {
    expect(packageHostAllowed('http://ops.slash.test/Slash.exe', FEED)).toBe(false)
  })

  it('refuses what cannot be parsed rather than guessing', () => {
    expect(packageHostAllowed('not a url', FEED)).toBe(false)
    expect(packageHostAllowed('https://ops.slash.test/x.exe', 'not a url')).toBe(false)
  })
})

describe('the published checksum', () => {
  it('is read as hex or as base64, and compared as one', () => {
    expect(normaliseSha512(HEX)).toBe(HEX)
    expect(normaliseSha512(B64)).toBe(HEX)
    expect(normaliseSha512(HEX.toUpperCase())).toBe(HEX)
  })

  it('refuses anything that is not a SHA-512', () => {
    expect(normaliseSha512('deadbeef')).toBeNull()
    expect(normaliseSha512(createHash('sha256').update('slash').digest('hex'))).toBeNull()
    expect(normaliseSha512('')).toBeNull()
  })
})

describe('the file it writes', () => {
  it('uses the name from the address when it is one', () => {
    expect(packageFileName('https://x.test/Slash-Setup-1.2.3.exe', '1.2.3')).toBe(
      'Slash-Setup-1.2.3.exe'
    )
  })

  it('invents a safe name rather than using anything path-like', () => {
    // A name from the network is not a path, and the only safe treatment of
    // one is to not use it.
    expect(packageFileName('https://x.test/..%2F..%2Fevil.exe', '1.0.0')).toBe('....evil.exe')
    expect(packageFileName('https://x.test/notes.txt', '1.0.0')).toBe('Slash-Setup-1.0.0.exe')
    expect(packageFileName('https://x.test/', '1.0.0')).toBe('Slash-Setup-1.0.0.exe')
  })
})

describe('planInstall', () => {
  const good = { version: '1.2.3', fileUrl: 'https://ops.slash.test/Slash.exe', sha512: HEX, size: 100 }

  it('plans an install from a complete entry', () => {
    const verdict = planInstall(good, FEED)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.plan.sha512).toBe(HEX)
      expect(verdict.plan.fileName).toBe('Slash.exe')
      expect(verdict.plan.size).toBe(100)
    }
  })

  it('treats a check-only feed as "download it yourself", not as an error', () => {
    // This is the feed this browser has always understood: a version and a
    // page to read about it.
    const verdict = planInstall({ version: '1.2.3' }, FEED)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.problem).toContain('release page')
  })

  it('refuses a package with no checksum to check it against', () => {
    const verdict = planInstall({ ...good, sha512: '' }, FEED)
    expect(verdict.ok).toBe(false)
  })

  it('refuses a checksum that is not one', () => {
    const verdict = planInstall({ ...good, sha512: 'nonsense' }, FEED)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.problem).toContain('SHA-512')
  })

  it('refuses a foreign host', () => {
    const verdict = planInstall({ ...good, fileUrl: 'https://evil.test/Slash.exe' }, FEED)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.problem).toContain('same host')
  })

  it('refuses an implausible size', () => {
    expect(planInstall({ ...good, size: MAX_PACKAGE_BYTES + 1 }, FEED).ok).toBe(false)
    expect(planInstall({ ...good, size: -1 }, FEED).ok).toBe(false)
  })

  it('accepts an absent size rather than inventing one', () => {
    const verdict = planInstall({ ...good, size: null }, FEED)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.plan.size).toBe(0)
  })
})

describe('the shape a GitHub-hosted feed must have', () => {
  // The release workflow uploads a `latest.json` beside the installer, so that
  // a feed can be served from GitHub with no database and no secret anywhere.
  // This pins the contract that file has to meet: change either side and this
  // fails rather than the updater silently finding nothing.
  const latestJson = {
    version: '0.2.0',
    releaseUrl: 'https://github.com/luckmeth/slash-browser/releases/tag/v0.2.0',
    notes: 'What changed.',
    fileUrl:
      'https://github.com/luckmeth/slash-browser/releases/download/v0.2.0/Slash-0.2.0-x64.exe',
    sha512: HEX,
    size: 178192486
  }

  it('plans an install straight from it', () => {
    const feed = 'https://github.com/luckmeth/slash-browser/releases/latest/download/latest.json'
    const verdict = planInstall(latestJson, feed)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.plan.fileName).toBe('Slash-0.2.0-x64.exe')
      expect(verdict.plan.size).toBe(178192486)
    }
  })

  it('is accepted from the Supabase feed too, since the asset is on GitHub', () => {
    // The two hosting choices are independent: the feed says where the file is,
    // and a GitHub release asset is allowed from either.
    expect(planInstall(latestJson, FEED).ok).toBe(true)
  })
})
