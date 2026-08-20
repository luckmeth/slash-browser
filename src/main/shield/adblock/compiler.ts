import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FiltersEngine } from '@ghostery/adblocker'

/**
 * Compiles the bundled filter lists into a serialised engine, in a utility
 * process.
 *
 * Parsing ~4.3 MB of EasyList and friends takes roughly **900 ms**. Deserialising
 * the compiled result takes **7 ms**. That ratio is the whole reason this file
 * exists: principle 1 is that no feature may add latency to the browsing path,
 * and a one-second stall on the main thread would be exactly that — it is every
 * tab switch and every IPC reply while it runs.
 *
 * So the expensive half happens here, off the main thread, and main only ever
 * deserialises. Same reasoning as the embedding worker, and a second rollup
 * entry for the same reason: `utilityProcess.fork` needs a real file, and
 * keeping the parser out of the main bundle makes "this must not run in main"
 * structural rather than a convention someone has to remember.
 *
 * It imports nothing from `shared/` — dragging zod into a worker that speaks
 * two message shapes would cost more than the worker saves.
 */

/** Bumped when the cache format or the parse options change. */
const CACHE_VERSION = 1

interface CompileRequest {
  kind: 'compile'
  /** Directory holding the bundled `.txt` lists. */
  listsDir: string
  /** Where to write the serialised engine. */
  cachePath: string
}

interface CompileResult {
  kind: 'compiled' | 'failed'
  /** Fingerprint of the inputs, so main can tell a stale cache from a fresh one. */
  fingerprint?: string
  filterCount?: number
  bytes?: number
  ms?: number
  error?: string
}

/**
 * Identifies the exact inputs a cache was built from.
 *
 * Name and byte length of every list, plus the format version. Deliberately not
 * mtime: copying the app or restoring a backup changes mtimes without changing
 * a single rule, and rebuilding for a second on every launch after a restore
 * would be a mysterious, recurring stall.
 */
export function fingerprintLists(listsDir: string): string {
  const names = readdirSync(listsDir)
    .filter((name) => name.endsWith('.txt'))
    .sort()
  const parts = names.map((name) => `${name}:${statSync(join(listsDir, name)).size}`)
  return `v${CACHE_VERSION}|${parts.join('|')}`
}

function compile(request: CompileRequest): CompileResult {
  const started = Date.now()
  try {
    const names = readdirSync(request.listsDir)
      .filter((name) => name.endsWith('.txt'))
      .sort()
    if (names.length === 0) return { kind: 'failed', error: 'no filter lists found' }

    const text = names
      .map((name) => readFileSync(join(request.listsDir, name), 'utf8'))
      .join('\n')

    const engine = FiltersEngine.parse(text, {
      // Compression roughly halves the serialised size at no measurable cost to
      // matching, which matters because this file is read at every launch.
      enableCompression: true,
      // Cosmetic rules are wanted: hiding the empty box an ad leaves behind is
      // most of the visible difference between this and a DNS blocker.
      loadCosmeticFilters: true,
      // Scriptlets from the lists are deliberately NOT loaded. Their bodies live
      // in uBlock's GPLv3 scriptlet library, and bundling executable GPL code
      // into this app carries obligations that filter lists — data, shipped with
      // attribution — do not. The one scriptlet Slash needs is written locally.
      loadExtendedSelectors: false
    })

    const serialised = engine.serialize()
    writeFileSync(request.cachePath, serialised)

    return {
      kind: 'compiled',
      fingerprint: fingerprintLists(request.listsDir),
      bytes: serialised.byteLength,
      ms: Date.now() - started
    }
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

process.parentPort?.on('message', (event) => {
  const request = event.data as CompileRequest
  if (!request || request.kind !== 'compile') return
  process.parentPort?.postMessage(compile(request))
})
