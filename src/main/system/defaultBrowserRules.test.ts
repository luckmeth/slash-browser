import { describe, it, expect } from 'vitest'
import {
  openTargetFromArgv,
  shouldOfferDefault,
  toFileUrl,
  PROMPT_LIMITS,
  type PromptState
} from './defaultBrowserRules'

const state = (over: Partial<PromptState> = {}): PromptState => ({
  isDefault: false,
  asks: 0,
  lastAskedAt: 0,
  suppressed: false,
  ...over
})

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)

describe('shouldOfferDefault', () => {
  it('offers on a fresh install', () => {
    expect(shouldOfferDefault(state(), NOW)).toBe(true)
  })

  it('never offers when Slash already is the default', () => {
    // An offer to do something already done reads as a browser that cannot tell.
    expect(shouldOfferDefault(state({ isDefault: true }), NOW)).toBe(false)
  })

  it('stops when somebody says not to ask again', () => {
    expect(shouldOfferDefault(state({ suppressed: true }), NOW)).toBe(false)
  })

  it('asks a second time, a fortnight later', () => {
    const asked = state({ asks: 1, lastAskedAt: NOW - PROMPT_LIMITS.minGapMs - 1 })
    expect(shouldOfferDefault(asked, NOW)).toBe(true)
  })

  it('does not ask again the next day', () => {
    const asked = state({ asks: 1, lastAskedAt: NOW - 24 * 60 * 60 * 1000 })
    expect(shouldOfferDefault(asked, NOW)).toBe(false)
  })

  it('stops for good after the second ask', () => {
    // A third is nagging, and nagging never reads as confidence in the product.
    const asked = state({ asks: PROMPT_LIMITS.maxAsks, lastAskedAt: NOW - 10 * PROMPT_LIMITS.minGapMs })
    expect(shouldOfferDefault(asked, NOW)).toBe(false)
  })
})

describe('openTargetFromArgv', () => {
  it('opens a URL Windows handed us', () => {
    expect(openTargetFromArgv(['C:/Slash/Slash.exe', 'https://example.com/a?b=c'])).toBe(
      'https://example.com/a?b=c'
    )
  })

  it('ignores the executable itself', () => {
    // argv[0] is a path, and one that ends in .exe would otherwise be a target.
    expect(openTargetFromArgv(['C:/Slash/Slash.exe'])).toBeNull()
  })

  it('ignores flags, including ours', () => {
    expect(openTargetFromArgv(['Slash.exe', '--new-private-window', '--profile=work'])).toBeNull()
  })

  it('finds the URL among flags', () => {
    expect(openTargetFromArgv(['Slash.exe', '--new-window', 'https://example.com'])).toBe(
      'https://example.com'
    )
  })

  it('ignores the project directory Electron passes in development', () => {
    // `electron .` — a real path, and opening it would be a surprise every launch.
    expect(openTargetFromArgv(['electron.exe', '.'])).toBeNull()
    expect(openTargetFromArgv(['electron.exe', 'D:/Projects/Slash Browser'])).toBeNull()
  })

  it('opens a local HTML file, from the .html association', () => {
    expect(openTargetFromArgv(['Slash.exe', 'C:\\pages\\index.html'])).toBe(
      'file:///C:/pages/index.html'
    )
  })

  it('refuses anything that is not a web page', () => {
    // A caller must not be able to talk the browser into opening a scheme we
    // never registered for.
    expect(openTargetFromArgv(['Slash.exe', 'javascript:alert(1)'])).toBeNull()
    expect(openTargetFromArgv(['Slash.exe', 'C:/secrets/keys.txt'])).toBeNull()
    expect(openTargetFromArgv(['Slash.exe', 'ftp://example.com'])).toBeNull()
  })
})

describe('toFileUrl', () => {
  it('escapes a path with spaces', () => {
    expect(toFileUrl('C:\\Program Files\\a.html')).toBe('file:///C:/Program%20Files/a.html')
  })

  it('keeps the drive colon readable', () => {
    expect(toFileUrl('D:/x.html')).toBe('file:///D:/x.html')
  })
})
