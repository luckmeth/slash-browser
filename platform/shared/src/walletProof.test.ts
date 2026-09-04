import { keccak_256 } from '@noble/hashes/sha3.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import { verifyWalletProof } from './walletProof'

/**
 * A real key, a real signature, and the ways a forged one must fail.
 *
 * Signed here rather than pasted from a fixture so the test proves the
 * verifier against the actual algorithm rather than against one recorded
 * output — including the EIP-191 prefix, which is the part that silently
 * recovers a different address when it is wrong.
 */
const KEY = Uint8Array.from(Buffer.from('4c0883a69102937d6231471b5dbb6204fe512961708279f1f4e0a25b1a2f8d0e', 'hex'))

function addressOf(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false)
  return `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(-20)).toString('hex')}`
}

function sign(message: string, privateKey: Uint8Array): string {
  const body = new TextEncoder().encode(message)
  const prefix = new TextEncoder().encode(`Ethereum Signed Message:\n${body.length}`)
  const joined = new Uint8Array(prefix.length + body.length)
  joined.set(prefix, 0)
  joined.set(body, prefix.length)

  // The library returns `v || r || s`; a wallet emits `r || s || v` with v
  // offset by 27, so the test produces what a wallet would.
  const recovered = secp256k1.sign(keccak_256(joined), privateKey, { format: 'recovered', prehash: false })
  const out = new Uint8Array(65)
  out.set(recovered.slice(1), 0)
  out[64] = 27 + (recovered[0] ?? 0)
  return `0x${Buffer.from(out).toString('hex')}`
}

const ADDRESS = addressOf(KEY)
const CHALLENGE = 'Slash Coin payout wallet verification\n\nAccount: abc\nNonce: 1234'

describe('a genuine signature', () => {
  it('recovers the address that signed', () => {
    const verdict = verifyWalletProof('ethereum', ADDRESS, CHALLENGE, sign(CHALLENGE, KEY))
    expect(verdict.ok).toBe(true)
  })

  it('does not care about the case an address is written in', () => {
    // Mixed case in an address is a checksum, not part of the value.
    const verdict = verifyWalletProof('polygon', ADDRESS.toUpperCase().replace('0X', '0x'), CHALLENGE, sign(CHALLENGE, KEY))
    expect(verdict.ok).toBe(true)
  })

  it('works on every chain that shares the format', () => {
    for (const network of ['ethereum', 'polygon', 'bsc']) {
      expect(verifyWalletProof(network, ADDRESS, CHALLENGE, sign(CHALLENGE, KEY)).ok).toBe(true)
    }
  })
})

describe('the ways a proof must fail', () => {
  it('refuses a signature over a different challenge', () => {
    // The replay that matters: a signature captured from an older challenge.
    const verdict = verifyWalletProof('ethereum', ADDRESS, CHALLENGE, sign('some other text', KEY))
    expect(verdict.ok).toBe(false)
  })

  it('refuses a valid signature from a different key', () => {
    const other = Uint8Array.from(Buffer.from('1'.repeat(64), 'hex'))
    const verdict = verifyWalletProof('ethereum', ADDRESS, CHALLENGE, sign(CHALLENGE, other))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('belongs to')
  })

  it('refuses a mangled signature rather than throwing', () => {
    for (const signature of ['', '0x', 'not hex', `0x${'ab'.repeat(64)}`]) {
      const verdict = verifyWalletProof('ethereum', ADDRESS, CHALLENGE, signature)
      expect(verdict.ok).toBe(false)
    }
  })

  it('refuses an empty challenge, which anything would satisfy', () => {
    expect(verifyWalletProof('ethereum', ADDRESS, '', sign('', KEY)).ok).toBe(false)
  })

  it('says a chain it cannot check is unsupported rather than failing it', () => {
    // The distinction matters to an operator: "wrong" and "we did not look"
    // lead to different decisions.
    const verdict = verifyWalletProof('solana', ADDRESS, CHALLENGE, sign(CHALLENGE, KEY))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.unsupported).toBe(true)
      expect(verdict.reason).toContain('by hand')
    }
  })

  it('refuses an address that is not the right shape', () => {
    expect(verifyWalletProof('ethereum', 'nonsense', CHALLENGE, sign(CHALLENGE, KEY)).ok).toBe(false)
  })
})
