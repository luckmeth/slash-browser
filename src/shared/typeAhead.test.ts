import { describe, it, expect } from 'vitest'
import { shouldStartTyping, type KeyFacts } from './typeAhead'

const facts = (over: Partial<KeyFacts> = {}): KeyFacts => ({
  key: 'a',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  targetTag: 'DIV',
  targetEditable: false,
  ...over
})

describe('shouldStartTyping', () => {
  it.each(['a', 'Z', '7', '?', '-', 'ß', 'é', '中'])('starts on %s', (key) => {
    expect(shouldStartTyping(facts({ key }))).toBe(true)
  })

  it.each(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'F5', 'Shift', 'Home', 'Delete'])(
    'ignores %s',
    (key) => {
      // One rule covers all of these: `key` is multi-character for every
      // non-printable key, so there is no list to keep up to date.
      expect(shouldStartTyping(facts({ key }))).toBe(false)
    }
  )

  it('ignores a bare space, which scrolls', () => {
    expect(shouldStartTyping(facts({ key: ' ' }))).toBe(false)
  })

  it.each([
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['alt', { altKey: true }]
  ])('ignores a %s shortcut', (_name, mods) => {
    // Swallowing Ctrl+L or Ctrl+T into a search box would break the browser's
    // own shortcuts, which is far worse than missing a character.
    expect(shouldStartTyping(facts(mods))).toBe(false)
  })

  it('allows AltGr, which is how some layouts type @ and #', () => {
    // AltGr arrives as ctrl+alt together and does produce a character. Treating
    // it as a shortcut would make the feature unusable on several European
    // keyboards.
    expect(shouldStartTyping(facts({ key: '@', ctrlKey: true, altKey: true }))).toBe(true)
  })

  it.each(['INPUT', 'TEXTAREA'])('ignores keys while focus is in a %s', (targetTag) => {
    expect(shouldStartTyping(facts({ targetTag }))).toBe(false)
  })

  it('ignores keys inside a contenteditable', () => {
    expect(shouldStartTyping(facts({ targetEditable: true }))).toBe(false)
  })
})
