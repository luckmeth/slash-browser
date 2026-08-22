import { describe, it, expect } from 'vitest'
import { decrypt, deriveKey, encrypt, verifier, verifierMatches } from './crypto'

describe('deriveKey', () => {
  it('gives the same key for the same passphrase and salt', () => {
    // The whole basis of a second device being able to read the first one's
    // data without the key ever being transmitted.
    const first = deriveKey('correct horse battery staple')
    const again = deriveKey('correct horse battery staple', first.salt)
    expect(again.key.equals(first.key)).toBe(true)
  })

  it('gives a different key for a different passphrase', () => {
    const salt = deriveKey('one').salt
    expect(deriveKey('one', salt).key.equals(deriveKey('two', salt).key)).toBe(false)
  })

  it('generates a fresh salt when none is given', () => {
    expect(deriveKey('same').salt).not.toBe(deriveKey('same').salt)
  })

  it('normalises the passphrase, so the same characters typed differently still work', () => {
    // "é" can be one code point or two. A user typing it on a different keyboard
    // would otherwise derive a different key and see an empty, silent account.
    const salt = deriveKey('x').salt
    const composed = deriveKey('caf\u00e9', salt)
    const decomposed = deriveKey('cafe\u0301', salt)
    expect(composed.key.equals(decomposed.key)).toBe(true)
  })

  it('refuses a salt of the wrong length rather than deriving a weak key', () => {
    expect(() => deriveKey('x', 'ab')).toThrow()
  })
})

describe('encrypt / decrypt', () => {
  const { key } = deriveKey('a passphrase', '00112233445566778899aabbccddeeff')

  it('round-trips', () => {
    const secret = JSON.stringify({ url: 'https://example.com', title: 'Example' })
    expect(decrypt(key, encrypt(key, secret))).toBe(secret)
  })

  it('round-trips text that is not ASCII', () => {
    const secret = 'ünïcödé — 日本語 — 🔐'
    expect(decrypt(key, encrypt(key, secret))).toBe(secret)
  })

  it('round-trips an empty string', () => {
    expect(decrypt(key, encrypt(key, ''))).toBe('')
  })

  it('never produces the same ciphertext twice', () => {
    // A repeated IV under GCM leaks the XOR of two plaintexts and the
    // authentication key with it. The IV is generated inside encrypt precisely
    // so no caller can pass the same one twice.
    expect(encrypt(key, 'same')).not.toBe(encrypt(key, 'same'))
  })

  it('returns null for the wrong key rather than plausible rubbish', () => {
    const other = deriveKey('different', '00112233445566778899aabbccddeeff').key
    expect(decrypt(other, encrypt(key, 'secret'))).toBeNull()
  })

  it('returns null when a byte has been altered', () => {
    // Authenticated encryption: a server that tampers gets a decryption failure
    // rather than something that quietly lands in the user's bookmarks.
    const encoded = encrypt(key, 'secret')
    const raw = Buffer.from(encoded, 'base64')
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff
    expect(decrypt(key, raw.toString('base64'))).toBeNull()
  })

  it('returns null for truncated or nonsense input', () => {
    // One unreadable row must not fail the whole sync — the rest of the user's
    // data is fine.
    expect(decrypt(key, 'AAAA')).toBeNull()
    expect(decrypt(key, '')).toBeNull()
    expect(decrypt(key, 'not base64 at all!!')).toBeNull()
  })

  it('does not leak the plaintext into the ciphertext', () => {
    expect(encrypt(key, 'https://secret.example.com')).not.toContain('secret')
  })
})

describe('verifier', () => {
  const salt = '00112233445566778899aabbccddeeff'

  it('matches for the same passphrase', () => {
    // Lets a second device tell "wrong passphrase" from "no data yet" — without
    // it a typo looks like a fresh account, and the user starts a second,
    // permanently diverged history.
    const a = deriveKey('shared', salt).key
    const b = deriveKey('shared', salt).key
    expect(verifierMatches(b, verifier(a))).toBe(true)
  })

  it('does not match a different passphrase', () => {
    const a = deriveKey('shared', salt).key
    const b = deriveKey('other', salt).key
    expect(verifierMatches(b, verifier(a))).toBe(false)
  })

  it('rejects malformed input without throwing', () => {
    const key = deriveKey('shared', salt).key
    expect(verifierMatches(key, '')).toBe(false)
    expect(verifierMatches(key, 'zzzz')).toBe(false)
  })

  it('does not contain the key', () => {
    const key = deriveKey('shared', salt).key
    expect(verifier(key)).not.toContain(key.toString('hex').slice(0, 8))
  })
})
