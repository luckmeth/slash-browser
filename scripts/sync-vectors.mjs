/**
 * Generates cross-platform crypto vectors for the mobile shells.
 *
 * Sync is a two-implementation protocol, and a mismatch between them produces
 * no useful error: every item just fails to decrypt, which presents to the user
 * as a wrong passphrase. So the Android side is checked against values produced
 * by *running* this code rather than against somebody's reading of it.
 *
 * The output is pasted into `SyncCryptoProbe.kt`. Re-run it if `crypto.ts` or
 * `historySync.ts` ever change — a change there that is not reflected in the
 * probe silently breaks interoperability with every shipped mobile build.
 *
 *   node scripts/sync-vectors.mjs
 */
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'vec-'))

async function load(entry, name) {
  const out = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false
  })
  const p = join(dir, name + '.mjs')
  writeFileSync(p, out.outputFiles[0].text)
  return import(pathToFileURL(p).href)
}

const crypto = await load('src/main/sync/crypto.ts', 'crypto')
const history = await load('src/main/sync/historySync.ts', 'history')

const SALT = '000102030405060708090a0b0c0d0e0f'
const PASS = 'correct horse battery staple'
const { key } = crypto.deriveKey(PASS, SALT)

console.log(JSON.stringify({
  passphrase: PASS,
  saltHex: SALT,
  keyHex: key.toString('hex'),
  verifierHex: crypto.verifier(key),
  ciphertextOfHello: crypto.encrypt(key, 'hello from the desktop'),
  plaintext: 'hello from the desktop',
  historyUrl: 'https://example.com/a-private-page',
  historyId: history.historyItemId(key, 'https://example.com/a-private-page'),
  unicodePassphrase: 'cafe\u0301 \u30d1\u30b9',
  unicodeKeyHex: crypto.deriveKey('cafe\u0301 \u30d1\u30b9', SALT).key.toString('hex')
}, null, 2))
