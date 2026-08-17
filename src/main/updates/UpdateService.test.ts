import { describe, it, expect } from 'vitest'
import { compareVersions, parseFeed } from './UpdateService'

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    // The bug this exists to prevent: lexically '0.10.0' < '0.9.0', so a user on
    // 0.9.0 would never be offered 0.10.0 — the update would simply never arrive.
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
  })

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })

  it('handles missing segments', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.3', '1.2.9')).toBe(1)
  })

  it('ignores a pre-release suffix rather than mis-ranking it', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0)
  })

  it('does not crash on nonsense', () => {
    expect(compareVersions('', '1.0.0')).toBe(-1)
    expect(compareVersions('banana', '1.0.0')).toBe(-1)
  })
})

describe('parseFeed', () => {
  it('reads a JSON feed', () => {
    expect(parseFeed('{"version":"1.2.3"}')).toEqual({ version: '1.2.3' })
  })

  it('reads the version out of electron-updater’s latest.yml', () => {
    const yaml = [
      'version: 0.2.0',
      'files:',
      '  - url: Slash-0.2.0-x64.exe',
      '    sha512: abc==',
      'path: Slash-0.2.0-x64.exe',
      'releaseDate: 2026-08-17T00:00:00.000Z'
    ].join('\n')
    expect(parseFeed(yaml)).toEqual({ version: '0.2.0' })
  })

  it('reads a quoted version', () => {
    expect(parseFeed("version: '0.3.1'")).toEqual({ version: '0.3.1' })
  })

  it('carries a release URL when the feed offers one', () => {
    const yaml = 'version: 1.0.0\nreleaseUrl: https://example.com/releases/1.0.0'
    expect(parseFeed(yaml)).toEqual({
      version: '1.0.0',
      releaseUrl: 'https://example.com/releases/1.0.0'
    })
  })

  it('returns null when there is no version to read', () => {
    // A feed that cannot say what the newest version is has told us nothing, and
    // guessing would be worse than reporting the feed as unreadable.
    expect(parseFeed('path: Slash.exe\nsha512: abc==')).toBeNull()
    expect(parseFeed('not a feed')).toBeNull()
    expect(parseFeed('{ broken json')).toBeNull()
    expect(parseFeed('')).toBeNull()
  })
})
