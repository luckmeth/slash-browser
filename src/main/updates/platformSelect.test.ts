import { describe, expect, it } from 'vitest'
import { planInstall, platformKey, selectPackage, type FeedEntry } from './updatePlan'

const FEED = 'https://github.com/luckmeth/slash-releases/releases/latest/download/latest.json'
const base = 'https://github.com/luckmeth/slash-releases/releases/download/v0.3.0'
const sha = 'a'.repeat(128)

/** What the release workflow now writes: flat Windows fields plus the map. */
const multi: FeedEntry = {
  version: '0.3.0',
  fileUrl: `${base}/Slash-0.3.0-x64.exe`,
  sha512: sha,
  size: 176_000_000,
  platforms: {
    'win32-x64': { fileUrl: `${base}/Slash-0.3.0-x64.exe`, sha512: sha, size: 176_000_000 },
    'darwin-arm64': { fileUrl: `${base}/Slash-0.3.0-arm64.dmg`, sha512: sha, size: 150_000_000 },
    'darwin-x64': { fileUrl: `${base}/Slash-0.3.0-x64.dmg`, sha512: sha, size: 160_000_000 }
  }
}

/** What every release before macOS existed published, and old clients still read. */
const legacy: FeedEntry = {
  version: '0.2.9',
  fileUrl: `${base}/Slash-0.2.9-x64.exe`,
  sha512: sha,
  size: 176_000_000
}

describe('choosing a package for this machine', () => {
  it('gives each platform its own file', () => {
    expect(selectPackage(multi, 'win32-x64').fileUrl).toContain('.exe')
    expect(selectPackage(multi, 'darwin-arm64').fileUrl).toContain('arm64.dmg')
    expect(selectPackage(multi, 'darwin-x64').fileUrl).toContain('x64.dmg')
  })

  it('never hands a Mac the Windows installer', () => {
    // The failure this guards against is quiet and convincing: an .exe
    // downloads, verifies against its checksum perfectly, and is then simply
    // unopenable — which reads as a corrupt download, not a wrong file.
    for (const key of ['darwin-arm64', 'darwin-x64']) {
      expect(selectPackage(legacy, key)).toEqual({})
      expect(planInstall(legacy, FEED, key).ok).toBe(false)
    }
  })

  it('still reads the flat fields on Windows, so older feeds keep working', () => {
    const chosen = selectPackage(legacy, 'win32-x64')
    expect(chosen.fileUrl).toBe(`${base}/Slash-0.2.9-x64.exe`)
    expect(planInstall(legacy, FEED, 'win32-x64').ok).toBe(true)
  })

  it('prefers the map over the flat fields when both are present', () => {
    const odd: FeedEntry = {
      ...legacy,
      platforms: { 'win32-x64': { fileUrl: `${base}/Slash-newer-x64.exe`, sha512: sha, size: 10 } }
    }
    expect(selectPackage(odd, 'win32-x64').fileUrl).toContain('Slash-newer')
  })

  it('ignores a map entry that names no file', () => {
    const empty: FeedEntry = { ...legacy, platforms: { 'win32-x64': { sha512: sha } } }
    // Falls through to the flat fields rather than reporting nothing to install.
    expect(selectPackage(empty, 'win32-x64').fileUrl).toContain('Slash-0.2.9')
  })

  it('has nothing for a platform the feed does not carry', () => {
    expect(selectPackage(multi, 'linux-x64')).toEqual({})
  })
})

describe('the plan that comes out', () => {
  it('keeps the .dmg name rather than renaming it to an installer', () => {
    const verdict = planInstall(multi, FEED, 'darwin-arm64')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.plan.fileName).toBe('Slash-0.3.0-arm64.dmg')
      expect(verdict.plan.size).toBe(150_000_000)
    }
  })

  it('applies the same host rule to every platform', () => {
    // A per-platform entry must not be a way around the one check that stops a
    // feed sending this browser to fetch an executable from anywhere it likes.
    const hostile: FeedEntry = {
      version: '0.3.0',
      platforms: {
        'darwin-arm64': { fileUrl: 'https://evil.test/Slash.dmg', sha512: sha, size: 10 }
      }
    }
    expect(planInstall(hostile, FEED, 'darwin-arm64').ok).toBe(false)
  })
})

describe('platformKey', () => {
  it('matches how Node names things, because that is what the feed is keyed by', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformKey('win32', 'x64')).toBe('win32-x64')
  })
})
