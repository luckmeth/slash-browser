import { keccak_256 } from '@noble/hashes/sha3.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

/**
 * Proving that a payout wallet belongs to the person asking to be paid.
 *
 * Storing an address proves nothing: it is text somebody typed, and a payout
 * to an address nobody verified is a payout to whoever typed last. The proof
 * is a signature — the holder of the private key signs a challenge Slash
 * issued, and the address is recovered from the signature. If the recovered
 * address is the one on the account, the key that controls it signed.
 *
 * **This runs server-side, in Slash Operations, and nowhere else.** A browser
 * that marked its own wallet verified would be proving nothing at all, and
 * Postgres cannot do secp256k1 recovery, so the check lives in the one place
 * that is both trusted and capable.
 *
 * Ethereum-family only — Ethereum, Polygon and BNB Smart Chain share both the
 * address format and `personal_sign`. Solana (ed25519), Tron (a different
 * prefix and encoding) and Bitcoin (its own message format) each need their
 * own verifier, and claiming to check one of those while not checking it would
 * be worse than saying it is unsupported. `verifyWalletProof` returns
 * `unsupported` for them, which the operator screen shows as exactly that.
 *
 * Two details here are the whole correctness of it, and both fail *silently*
 * by recovering a different but perfectly valid address — which reads as a
 * forgery rather than as a bug, and would have rejected every honest wallet:
 *
 *  - the prefix begins with the byte **0x19**, which is part of EIP-191;
 *  - recovery runs with `prehash: false`, because what it is handed is already
 *    a keccak digest and the default would hash it a second time.
 *
 * **Not yet checked against a signature from a real wallet.** The tests sign
 * and recover with the same code, which proves the two halves agree and that
 * the algorithm is implemented as EIP-191 describes it; it does not prove that
 * MetaMask produces exactly this. Sign one challenge in a wallet and check it
 * here before the first payout depends on it — an operator can already see the
 * verdict on the Payouts screen, so this is one manual test, once.
 */

export type ProofVerdict =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly reason: string; readonly unsupported?: boolean }

/** The chains this can actually check. */
export const PROVABLE_NETWORKS = ['ethereum', 'polygon', 'bsc'] as const

/** `0x19` then the text. Exported so the test signs what a wallet signs. */
export const EIP191_PREFIX = '\u0019Ethereum Signed Message:\n'

/**
 * The digest a wallet actually signs for a "personal message".
 *
 * Not the message bytes: the keccak hash of the prefix, the byte length and
 * the message together.
 */
export function personalHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message)
  const prefix = new TextEncoder().encode(`${EIP191_PREFIX}${body.length}`)
  const joined = new Uint8Array(prefix.length + body.length)
  joined.set(prefix, 0)
  joined.set(body, prefix.length)
  return keccak_256(joined)
}

/** The last 20 bytes of the keccak hash of the public key, as `0x…`. */
function addressFromPublicKey(publicKey: Uint8Array): string {
  // Drop the 0x04 uncompressed-point marker before hashing.
  const hashed = keccak_256(publicKey.slice(1))
  return `0x${Buffer.from(hashed.slice(-20)).toString('hex')}`
}

/**
 * An Ethereum signature is `r || s || v`; this library wants `v || r || s`.
 *
 * The orders genuinely differ, and getting it wrong does not throw — it
 * recovers a different, valid-looking address. Converted in one place.
 */
function parseSignature(signature: string): Uint8Array | null {
  const clean = signature.trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{130}$/i.test(clean)) return null

  const bytes = Uint8Array.from(Buffer.from(clean, 'hex'))
  const raw = bytes[64] ?? 0
  // Wallets emit 27/28, and 0/1 where no chain id is folded in. Both are the
  // same value shifted; anything else is not a recovery byte.
  const recovery = raw >= 27 ? raw - 27 : raw
  if (recovery !== 0 && recovery !== 1) return null

  const recovered = new Uint8Array(65)
  recovered[0] = recovery
  recovered.set(bytes.slice(0, 64), 1)
  return recovered
}

/**
 * Whether this signature proves control of this address.
 *
 * Compared case-insensitively: an address is hex, and the mixed case some
 * wallets show is a checksum rather than part of the value.
 */
export function verifyWalletProof(
  network: string,
  address: string,
  challenge: string,
  signature: string
): ProofVerdict {
  if (!PROVABLE_NETWORKS.includes(network as (typeof PROVABLE_NETWORKS)[number])) {
    return {
      ok: false,
      unsupported: true,
      reason: `Slash cannot check a ${network || 'blank'} signature — only Ethereum, Polygon and BNB Smart Chain. Verify this one by hand before paying it.`
    }
  }
  if (challenge.trim() === '') return { ok: false, reason: 'No challenge was issued to sign.' }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
    return { ok: false, reason: 'That is not an Ethereum-format address.' }
  }

  const parsed = parseSignature(signature)
  if (!parsed) {
    return { ok: false, reason: 'That is not a 65-byte personal_sign signature.' }
  }

  try {
    const compressed = secp256k1.recoverPublicKey(parsed, personalHash(challenge), {
      prehash: false
    })
    // Recovery gives a compressed point; the address is the hash of the
    // uncompressed one.
    const recovered = addressFromPublicKey(secp256k1.Point.fromBytes(compressed).toBytes(false))

    return recovered.toLowerCase() === address.trim().toLowerCase()
      ? { ok: true, address: recovered }
      : {
          ok: false,
          reason: `That signature is valid but belongs to ${recovered}, not to the address on the account.`
        }
  } catch (cause) {
    return { ok: false, reason: `The signature could not be read (${String(cause)}).` }
  }
}
