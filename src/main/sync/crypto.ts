import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * End-to-end encryption for synced data.
 *
 * The server stores ciphertext and nothing else. That is not a nicety — it is
 * the only design consistent with a browser whose second principle is "nothing
 * leaves the machine unless the user turned it on". Sync that uploads readable
 * bookmarks has turned the local-first claim into a marketing line.
 *
 * The key comes from a passphrase the user chooses and which **never leaves this
 * machine** — not to the sync server, not to us, not in any request. The cost is
 * stated plainly in the settings copy: forget the passphrase and the synced data
 * is unrecoverable, because there is deliberately nobody holding a spare.
 *
 * `node:crypto` throughout. No native module, no dependency — this project
 * cannot build one anyway (see CLAUDE.md on node-gyp and paths with spaces).
 */

/** scrypt cost. ~100ms on a normal desktop: slow enough to matter, fast enough to unlock with. */
const SCRYPT_COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16

export interface SyncKey {
  readonly key: Buffer
  /** Stored alongside the ciphertext so another device can derive the same key. */
  readonly salt: string
}

/**
 * Derives the encryption key from a passphrase.
 *
 * The salt is stored with the data rather than derived from anything about the
 * user. Deriving it from an email — the obvious shortcut — would mean the same
 * passphrase produced the same key for every account sharing an address, and it
 * would leak the address to anybody holding the blob.
 */
export function deriveKey(passphrase: string, saltHex?: string): SyncKey {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(SALT_BYTES)
  if (salt.length !== SALT_BYTES) throw new Error('sync salt is the wrong length')
  const key = scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT_COST)
  return { key, salt: salt.toString('hex') }
}

/**
 * Encrypts one item.
 *
 * AES-256-GCM: authenticated, so a server that alters a byte produces a
 * decryption failure rather than plausible-looking rubbish that ends up in the
 * user's bookmarks.
 *
 * A fresh random IV every time. Reusing one with GCM is catastrophic — it leaks
 * the XOR of two plaintexts and, worse, the authentication key — so it is
 * generated here rather than being a parameter anybody could pass twice.
 */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // iv | tag | ciphertext, base64. One field, so there is nothing to line up
  // wrongly at the far end.
  return Buffer.concat([iv, tag, body]).toString('base64')
}

/**
 * Decrypts one item, or returns null.
 *
 * **Null rather than a throw.** A single corrupt or foreign item must not stop
 * a sync: the rest of the user's data is fine, and refusing all of it because
 * one row was written by a device with a different passphrase is a worse
 * outcome than skipping that row.
 */
export function decrypt(key: Buffer, encoded: string): string | null {
  try {
    const raw = Buffer.from(encoded, 'base64')
    if (raw.length < IV_BYTES + TAG_BYTES) return null

    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const body = raw.subarray(IV_BYTES + TAG_BYTES)

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // Wrong key, tampered ciphertext, or truncated data. All three are "cannot
    // read this one", and none of them should be distinguishable from outside.
    return null
  }
}

/**
 * A short check value proving two devices share a passphrase.
 *
 * Uploaded once so a second device can tell "wrong passphrase" from "no data
 * yet" — otherwise a typo looks exactly like a fresh account, and the user
 * cheerfully starts a second, parallel, permanently-diverged history.
 *
 * It is a hash of the derived key with a fixed label, so it reveals nothing
 * usable: recovering the passphrase from it costs the same scrypt work as
 * guessing it directly.
 */
export function verifier(key: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.alloc(IV_BYTES, 7))
  cipher.update('slash-sync-verifier', 'utf8')
  cipher.final()
  return cipher.getAuthTag().toString('hex')
}

/** Constant-time comparison, so a wrong passphrase cannot be narrowed by timing. */
export function verifierMatches(key: Buffer, expected: string): boolean {
  const ours = Buffer.from(verifier(key), 'hex')
  let theirs: Buffer
  try {
    theirs = Buffer.from(expected, 'hex')
  } catch {
    return false
  }
  if (ours.length !== theirs.length) return false
  return timingSafeEqual(ours, theirs)
}
