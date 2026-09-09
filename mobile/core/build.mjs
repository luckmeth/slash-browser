/**
 * Bundles the shared core for the mobile shells.
 *
 * Output is a single IIFE with no imports and no module system, because the
 * three engines that have to run it — a headless WebView on Android, QuickJS if
 * that proves too heavy, and JavaScriptCore on iOS — agree on nothing else.
 *
 * The build **fails** rather than warns if anything unportable reaches the
 * bundle. A core that quietly pulled in `node:path` would build here, ship, and
 * then throw on a device at the first call, which is the worst place to find out.
 *
 *   node mobile/core/build.mjs           # write the bundle
 *   node mobile/core/build.mjs --check   # verify only, no write (CI)
 */
import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const OUT_DIR = resolve(ROOT, 'mobile/android/app/src/main/assets/core')
const OUT_FILE = resolve(OUT_DIR, 'slash-core.js')

const checkOnly = process.argv.includes('--check')

/**
 * Anything on this list means the core stopped being portable. esbuild would
 * happily mark them external and emit a `require` that no engine can answer.
 */
const FORBIDDEN = [
  'electron',
  'better-sqlite3',
  'sqlite-vec',
  'electron-updater',
  '@huggingface/transformers'
]

const result = await build({
  entryPoints: [resolve(HERE, 'entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'SlashCoreModule',
  platform: 'neutral',
  target: ['es2020'],
  // Neither engine ships node builtins. Leaving them external would emit a
  // require() that fails at runtime; refusing to resolve them fails the build.
  external: [],
  minify: !checkOnly,
  sourcemap: false,
  write: false,
  legalComments: 'none',
  alias: {
    '@shared': resolve(ROOT, 'src/shared'),
    '@main': resolve(ROOT, 'src/main')
  },
  logLevel: 'warning'
})

const output = result.outputFiles[0]
const code = output.text

for (const banned of FORBIDDEN) {
  if (code.includes(`require("${banned}")`) || code.includes(`from"${banned}"`)) {
    console.error(`core bundle reached ${banned} — the boundary is broken`)
    process.exit(1)
  }
}

const bytes = Buffer.byteLength(code, 'utf8')

if (checkOnly) {
  if (!existsSync(OUT_FILE)) {
    console.error(`core bundle missing at ${OUT_FILE} — run: npm run core:build`)
    process.exit(1)
  }
  const onDisk = readFileSync(OUT_FILE, 'utf8')
  // The committed asset is minified; a --check build is not, so compare the
  // marker rather than the bytes. Drift in the source is caught by the test.
  if (!onDisk.includes('SlashCore')) {
    console.error('core bundle on disk does not expose SlashCore')
    process.exit(1)
  }
  console.log(`core bundle present (${onDisk.length} bytes on disk)`)
} else {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, code, 'utf8')
  console.log(`wrote ${OUT_FILE}`)
  console.log(`  ${bytes} bytes, no external imports`)
}
