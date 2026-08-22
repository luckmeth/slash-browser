import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  isValidProfileId,
  profileFromArgv,
  profileIdFrom,
  registryPathFor,
  userDataPathFor
} from './profilePaths'

describe('isValidProfileId', () => {
  it('accepts what can safely be a directory name', () => {
    expect(isValidProfileId('work')).toBe(true)
    expect(isValidProfileId('a')).toBe(true)
    expect(isValidProfileId('work-2')).toBe(true)
  })

  it('refuses anything that could escape the directory', () => {
    // The id becomes part of a filesystem path. A traversal here would point the
    // whole browser's storage somewhere it was never meant to write.
    expect(isValidProfileId('../evil')).toBe(false)
    expect(isValidProfileId('a/b')).toBe(false)
    expect(isValidProfileId('..')).toBe(false)
    expect(isValidProfileId('C:' + String.fromCharCode(92) + 'Windows')).toBe(false)
  })

  it('refuses the empty string and stray punctuation', () => {
    expect(isValidProfileId('')).toBe(false)
    expect(isValidProfileId('-work')).toBe(false)
    expect(isValidProfileId('work-')).toBe(false)
    expect(isValidProfileId('Work')).toBe(false)
  })
})

describe('profileIdFrom', () => {
  it('slugs a display name', () => {
    expect(profileIdFrom('Work Stuff')).toBe('work-stuff')
  })

  it('never produces an empty id', () => {
    // A name of only punctuation would otherwise slug to '' — and an empty id
    // resolves to the parent directory, which is every other profile.
    expect(profileIdFrom('!!!')).toBe('profile')
    expect(profileIdFrom('')).toBe('profile')
  })

  it('avoids colliding with an existing profile', () => {
    expect(profileIdFrom('Work', ['work'])).toBe('work-2')
    expect(profileIdFrom('Work', ['work', 'work-2'])).toBe('work-3')
  })

  it('always returns something valid', () => {
    for (const name of ['你好', '   ', '---', 'A'.repeat(200)]) {
      expect(isValidProfileId(profileIdFrom(name))).toBe(true)
    }
  })
})

describe('profileFromArgv', () => {
  it('reads both spellings', () => {
    expect(profileFromArgv(['slash.exe', '--profile=work'])).toBe('work')
    expect(profileFromArgv(['slash.exe', '--profile', 'work'])).toBe('work')
  })

  it('returns null when there is no flag', () => {
    expect(profileFromArgv(['slash.exe'])).toBeNull()
  })

  it('returns null rather than accepting a bad value', () => {
    // A typo must not create a new profile: a new profile looks exactly like
    // all of your data having disappeared.
    expect(profileFromArgv(['--profile=../escape'])).toBeNull()
    expect(profileFromArgv(['--profile='])).toBeNull()
    expect(profileFromArgv(['--profile'])).toBeNull()
  })

  it('lowercases, since ids are lowercase', () => {
    expect(profileFromArgv(['--profile=WORK'])).toBe('work')
  })
})

describe('userDataPathFor', () => {
  const base = 'C:/Users/x/AppData/Roaming/Slash'

  it('leaves the default profile exactly where it already is', () => {
    // An upgrade must not move somebody's bookmarks — moving the directory is
    // precisely how it would look as though they had been lost.
    expect(userDataPathFor(base, DEFAULT_PROFILE_ID)).toBe(base)
  })

  it('puts other profiles beside it, not inside it', () => {
    // Nested, the default profile's "delete all my data" would take every other
    // profile with it.
    const work = userDataPathFor(base, 'work')
    expect(work).toBe(`${base}-profile-work`)
    expect(work.startsWith(`${base}/`)).toBe(false)
  })

  it('falls back to the base path for an invalid id', () => {
    expect(userDataPathFor(base, '../evil')).toBe(base)
  })
})

describe('registryPathFor', () => {
  it('lives outside every profile, so all of them see the same list', () => {
    const base = 'C:/Users/x/AppData/Roaming/Slash'
    const registry = registryPathFor(base)
    expect(registry).toBe(`${base}-profiles.json`)
    expect(registry.startsWith(`${base}/`)).toBe(false)
  })
})
