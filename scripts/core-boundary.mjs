/**
 * Reports the portable core — every module whose transitive import graph never
 * reaches `electron`, a native module or a node builtin.
 *
 * The analysis itself lives in `src/core/boundary.ts` and is unit-tested there.
 * This file is only a way to look at it from a terminal; it deliberately holds
 * no copy of the rules, because a survey tool and its guard disagreeing about
 * what "portable" means is precisely how the three copies of the placement list
 * went wrong.
 *
 *   node scripts/core-boundary.mjs             # summary
 *   node scripts/core-boundary.mjs --list      # portable files, one per line
 *   node scripts/core-boundary.mjs --blocked   # unportable, with the reason
 *   node scripts/core-boundary.mjs --why <f>   # why one file is not portable
 *   node scripts/core-boundary.mjs --json
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The analysis is TypeScript because its tests are TypeScript. Bundling it here
// keeps one implementation rather than two that have to agree.
const bundled = await build({
  entryPoints: [resolve(ROOT, 'src/core/boundary.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  write: false,
  logLevel: 'warning'
})
const tmp = mkdtempSync(join(tmpdir(), 'slash-boundary-'))
const modulePath = join(tmp, 'boundary.mjs')
writeFileSync(modulePath, bundled.outputFiles[0].text, 'utf8')
const { analyseBoundary } = await import(pathToFileURL(modulePath).href)

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)

const report = analyseBoundary(ROOT)
const isTest = (f) => /\.test\.tsx?$/.test(f)

if (has('--why')) {
  const target = args[args.indexOf('--why') + 1]
  if (!target) {
    console.error('--why needs a file path, e.g. src/main/downloads/engine/DownloadQueue.ts')
    process.exit(2)
  }
  const needle = target.replace(/\\/g, '/')
  const hit = report.blocked.find((b) => b.file.endsWith(needle))
  if (!hit) {
    const portable = report.portable.find((f) => f.endsWith(needle))
    console.log(portable ? `${portable}\n  portable — nothing blocks it.` : `not found: ${target}`)
  } else {
    const hop = hit.via === hit.file ? 'directly' : `via ${hit.via}`
    console.log(`${hit.file}\n  blocked ${hop} — ${hit.specifier}`)
  }
} else if (has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else if (has('--list')) {
  for (const f of report.portable) console.log(f)
} else if (has('--blocked')) {
  for (const b of report.blocked) {
    const hop = b.via === b.file ? 'directly' : `via ${b.via}`
    console.log(`${b.file}\n    blocked ${hop} — ${b.specifier}`)
  }
} else {
  const src = report.portable.filter((f) => !isTest(f))
  const tests = report.portable.filter(isTest)
  const lines = (list) =>
    list.reduce((n, f) => n + readFileSync(resolve(ROOT, f), 'utf8').split('\n').length, 0)

  console.log('Portable core — transitively free of electron, native modules and node builtins')
  console.log(`  source files : ${src.length}  (${lines(src)} lines)`)
  console.log(`  test files   : ${tests.length}  (${lines(tests)} lines)`)
  console.log(`  blocked      : ${report.blocked.length}`)
  console.log('')

  /**
   * What it would cost to bring a blocked file into the core.
   *
   * The three classes are genuinely different pieces of work, and lumping them
   * together makes the core look either cheaper or dearer than it is:
   *
   *   shim    — pure computation the engine simply lacks. A few dozen lines,
   *             identical on both platforms. `node:path` alone unblocks 31 files.
   *   bridge  — real I/O. Needs a native implementation per platform behind an
   *             interface, which is the work the mobile plan already budgets for.
   *   rewrite — Electron or a native module. No shared answer exists; the shell
   *             reimplements the behaviour against the platform's own API.
   */
  const PURE = /^(node:)?(path|crypto|os|url|querystring|string_decoder|punycode|util|assert|buffer|events|timers)$/
  const IO = /^(node:)?(fs|fs\/promises|child_process|http|https|net|dns|tls|stream|worker_threads|zlib|cluster|dgram)$/
  const costOf = (s) => (PURE.test(s) ? 'shim' : IO.test(s) ? 'bridge' : 'rewrite')

  const byReason = new Map()
  for (const b of report.blocked) byReason.set(b.specifier, (byReason.get(b.specifier) ?? 0) + 1)
  console.log('Blocked by root cause:')
  const totals = { shim: 0, bridge: 0, rewrite: 0 }
  for (const [specifier, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    const cost = costOf(specifier)
    totals[cost] += n
    console.log(`  ${String(n).padStart(4)}  ${specifier.padEnd(28)} ${cost}`)
  }
  console.log(
    `        ${totals.shim} shimmable · ${totals.bridge} need a native bridge · ` +
      `${totals.rewrite} need a rewrite`
  )
  console.log('')

  const byDir = new Map()
  for (const f of src) {
    const dir = f.split('/').slice(0, 3).join('/')
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
  }
  console.log('Portable source by area:')
  for (const [dir, n] of [...byDir].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${dir}`)
  }
}
