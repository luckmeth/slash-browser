/**
 * The portable-core boundary, as a function rather than a convention.
 *
 * Phase A's claim is that Slash is already split into pure policy and
 * privileged I/O, so the mobile shells rewrite only the second half. That claim
 * is worth exactly as much as its enforcement: a single `import { app } from
 * 'electron'` added to a planning module would move it silently to the wrong
 * side of the line, and nothing would fail until an Android build tried to load
 * it on a device.
 *
 * So the graph is walked. A direct grep is not enough — a file importing no
 * Electron itself but importing a sibling that does is just as unportable, and
 * it fails at the point where a shell loads it rather than where somebody wrote
 * the import.
 *
 * Build-time only. This module reads the filesystem and is never bundled into
 * the core it describes.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'

/** Bare specifiers that make a module unportable to a mobile shell. */
export const NATIVE_ONLY = [
  'electron',
  'better-sqlite3',
  'sqlite-vec',
  'electron-updater',
  '@huggingface/transformers'
] as const

/**
 * Node builtins. A JS engine embedded in a native shell — a headless WebView on
 * Android, JavaScriptCore on iOS — provides none of these.
 *
 * `node:path` and `node:crypto` are the two that block the most files while
 * being the cheapest to shim, which is worth knowing before deciding what the
 * core can contain.
 */
export const NODE_BUILTIN =
  /^(node:)?(fs|fs\/promises|path|os|child_process|worker_threads|net|http|https|crypto|zlib|dns|tls|cluster|v8|vm|module|readline|repl|perf_hooks|inspector|stream|buffer|process|util|events|url|querystring|string_decoder|timers|assert|constants|punycode|tty|dgram|async_hooks|diagnostics_channel|trace_events|wasi)$/

export interface Blocker {
  /** The file that actually carries the unportable import. */
  readonly via: string
  /** The specifier that broke it. */
  readonly specifier: string
}

export interface BoundaryReport {
  readonly portable: readonly string[]
  readonly blocked: readonly (Blocker & { file: string })[]
}

const SOURCE = /\.tsx?$/
const DECLARATION = /\.d\.ts$/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Every static and dynamic import specifier in a source file.
 *
 * Regex rather than a parser because this runs over a few hundred files on
 * every test run, and the shapes that matter here are all unambiguous. A
 * specifier inside a string literal would be a false positive; there are none,
 * and one would fail loudly rather than silently letting something through.
 */
export function specifiersOf(source: string): string[] {
  const found = new Set<string>()
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) found.add(match[1]!)
  }
  return [...found]
}

export function isUnportable(specifier: string): boolean {
  if (NATIVE_ONLY.some((n) => specifier === n || specifier.startsWith(`${n}/`))) return true
  return NODE_BUILTIN.test(specifier)
}

/** Resolves an alias or relative specifier to a file, or null if it is a package. */
function resolveSpecifier(specifier: string, fromFile: string, root: string): string | null {
  let base: string
  if (specifier.startsWith('@shared/')) {
    base = resolve(root, 'src/shared', specifier.slice('@shared/'.length))
  } else if (specifier.startsWith('@main/')) {
    base = resolve(root, 'src/main', specifier.slice('@main/'.length))
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier)
  } else {
    return null
  }

  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const posix = (p: string) => p.replace(/\\/g, '/')

/**
 * Walks the transitive import graph from `entries` (or every file under
 * `roots`) and reports which modules are portable.
 *
 * Cycles resolve optimistically — a cycle among portable files is portable, and
 * a cycle touching an unportable one is caught on the other edge.
 */
export function analyseBoundary(
  root: string,
  options: { roots?: string[]; entries?: string[] } = {}
): BoundaryReport {
  const roots = options.roots ?? ['src/main', 'src/shared']
  const universe = options.entries
    ? []
    : roots.flatMap((r) => walk(resolve(root, r)))

  const graph = new Map<string, { deps: string[]; ownReasons: string[] }>()

  const load = (file: string): void => {
    if (graph.has(file)) return
    const source = readFileSync(file, 'utf8')
    const deps: string[] = []
    const ownReasons: string[] = []
    for (const specifier of specifiersOf(source)) {
      if (isUnportable(specifier)) {
        ownReasons.push(specifier)
        continue
      }
      const target = resolveSpecifier(specifier, file, root)
      if (target) deps.push(target)
    }
    graph.set(file, { deps, ownReasons })
    for (const dep of deps) load(dep)
  }

  const seeds = options.entries ? options.entries.map((e) => resolve(root, e)) : universe
  for (const file of seeds) load(file)

  const verdict = new Map<string, Blocker | null>()
  const blockedBy = (file: string, seen = new Set<string>()): Blocker | null => {
    const cached = verdict.get(file)
    if (cached !== undefined) return cached
    if (seen.has(file)) return null
    seen.add(file)

    const node = graph.get(file)
    if (!node) return null

    if (node.ownReasons.length > 0) {
      const result: Blocker = { via: posix(relative(root, file)), specifier: node.ownReasons[0]! }
      verdict.set(file, result)
      return result
    }
    for (const dep of node.deps) {
      const inner = blockedBy(dep, seen)
      if (inner) {
        verdict.set(file, inner)
        return inner
      }
    }
    return null
  }

  const portable: string[] = []
  const blocked: (Blocker & { file: string })[] = []
  for (const file of graph.keys()) {
    const rel = posix(relative(root, file))
    const why = blockedBy(file)
    if (why) blocked.push({ file: rel, ...why })
    else portable.push(rel)
  }

  portable.sort()
  blocked.sort((a, b) => a.file.localeCompare(b.file))
  return { portable, blocked }
}
