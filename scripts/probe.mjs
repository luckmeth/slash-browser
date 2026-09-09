#!/usr/bin/env node
/**
 * One command that runs the probes.
 *
 * **Why this exists.** There are around sixty probes in this project, each
 * behind its own environment variable, each run by hand and remembered by
 * nobody. They are the strongest quality tool here — four separate faults in one
 * session were found by a probe and by nothing else, after passing typecheck,
 * lint and the whole unit suite — and their weakness has never been their design.
 * It is that running one means knowing it exists.
 *
 * What this deliberately does **not** do is guess. A probe is run unattended
 * only if `scripts/probes.json` says somebody has verified it can be; everything
 * else is listed as unclassified or as needing a human, with the reason. A
 * harness that invents failures is worse than no harness, because the next real
 * failure gets ignored with the rest.
 *
 *   npm run probe -- --list                 what exists, and what is runnable
 *   npm run probe -- --all                  every probe marked unattended
 *   npm run probe -- SLASH_YT_TIMING_PROBE  one by name (prefix optional)
 *
 * Output goes to `probe-results/<timestamp>.log` as well as the terminal,
 * because a verdict you have to scroll back for is a verdict you will not read.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { setTimeout, clearTimeout } from 'node:timers'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'scripts', 'probes.json')
const indexPath = join(root, 'src', 'main', 'index.ts')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const unattended = manifest.unattended ?? {}
const manual = manifest.manual ?? {}

/**
 * Every probe the browser actually knows about.
 *
 * Read out of `index.ts` rather than kept as a second list, because two lists
 * that must agree are one commit away from disagreeing — and the failure mode is
 * a probe that quietly stops being run.
 */
function discover() {
  const source = readFileSync(indexPath, 'utf8')
  const found = new Set()
  for (const match of source.matchAll(/process\.env\['(SLASH_[A-Z0-9_]+)'\]/g)) {
    found.add(match[1])
  }
  return [...found].sort()
}

const args = process.argv.slice(2)
const all = discover()

if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].slice(3))
  process.exit(0)
}

if (args.includes('--list') || args.length === 0) {
  const classified = new Set([...Object.keys(unattended), ...Object.keys(manual)])
  const unclassified = all.filter((name) => !classified.has(name))

  console.log(`\n${all.length} probes in src/main/index.ts\n`)

  console.log(`Runnable unattended (${Object.keys(unattended).length}):`)
  for (const [name, info] of Object.entries(unattended)) {
    console.log(`  ${name}${info.network ? '  [needs network]' : ''}`)
    console.log(`      ${info.note}`)
  }

  console.log(`\nNeeds a human (${Object.keys(manual).length}):`)
  for (const [name, why] of Object.entries(manual)) {
    console.log(`  ${name}`)
    console.log(`      ${why}`)
  }

  console.log(`\nUnclassified — not run by --all (${unclassified.length}):`)
  console.log('  These have never been verified as safe to run unattended. Run one by')
  console.log('  name, and if it reaches a verdict on its own, add it to scripts/probes.json.')
  for (const name of unclassified) console.log(`  ${name}`)
  console.log('')
  process.exit(0)
}

const requested = args.includes('--all')
  ? Object.keys(unattended)
  : args
      .filter((arg) => !arg.startsWith('--'))
      .map((arg) => {
        // Typing the whole SLASH_..._PROBE every time is how a tool stops being
        // used. Exact name, then the obvious prefixes, then a unique substring —
        // ambiguity falls through and is reported rather than guessed at.
        const wanted = arg.toUpperCase().replace(/-/g, '_')
        const exact = all.find(
          (name) =>
            name === wanted ||
            name === `SLASH_${wanted}` ||
            name === `${wanted}_PROBE` ||
            name === `SLASH_${wanted}_PROBE`
        )
        if (exact) return exact
        const partial = all.filter((name) => name.includes(wanted))
        return partial.length === 1 ? partial[0] : wanted
      })

const unknown = requested.filter((name) => !all.includes(name))
if (unknown.length > 0) {
  console.error(`Not a probe this build knows about: ${unknown.join(', ')}`)
  console.error('Run with --list to see what exists.')
  process.exit(1)
}

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('No build in out/. Run `npx electron-vite build` first.')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const resultsDir = join(root, 'probe-results')
mkdirSync(resultsDir, { recursive: true })
const logPath = join(resultsDir, `${stamp}.log`)

const transcript = []
const summary = []

/**
 * The verdict lines a probe prints.
 *
 * Probes in this project report PASS / FAIL / INCONCLUSIVE / INVALID / MIXED, and
 * the last three exist because a probe that cannot tell "it worked" from "I could
 * not test it" is the thing that reported a working ad blocker twice while
 * adverts played. They are surfaced here as distinctly as a failure.
 */
function verdictOf(output) {
  const lines = output.split(/\r?\n/).filter((line) => /VERDICT|RESULT:/i.test(line))
  if (lines.length === 0) return { label: 'no verdict', ok: false }
  const last = lines[lines.length - 1]
  const found = /(PASS|FAIL|INCONCLUSIVE|INVALID|MIXED|NO RENDERER|[A-Z][A-Z ]{3,})/.exec(
    last.split(/VERDICT:?/i)[1] ?? last
  )
  const label = (found?.[1] ?? 'unclear').trim()
  return { label, ok: /^PASS$/.test(label) || /NO RENDERER/.test(label) }
}

/**
 * The Electron binary, resolved directly.
 *
 * **Not** `npx electron`, and not `shell: true`. A shelled-out child means
 * `child.kill()` kills the shell and leaves the browser running — the first
 * version of this script did exactly that, hung until every timeout expired and
 * left a pile of orphaned `electron.exe` behind. Spawning the real binary is
 * what makes the process tree ours to end.
 */
function electronBinary() {
  const dir = join(root, 'node_modules', 'electron')
  const name = readFileSync(join(dir, 'path.txt'), 'utf8').trim()
  return join(dir, 'dist', name)
}

/**
 * Ends the run the moment the probe has said what it found.
 *
 * Probes do not quit the browser — they log a verdict and leave it open, which
 * is right when a human is watching and wrong here. Waiting for the full timeout
 * on a probe that finished in eight seconds turns a two-minute sweep into twenty.
 */
const VERDICT_GRACE_MS = 2000

function run(name) {
  const info = unattended[name] ?? {}
  const timeoutMs = info.timeoutMs ?? 180_000

  // Every probe starts from the same clean profile. A restored session of
  // fifteen tabs is not the browser any of these set out to measure, and one
  // probe's leftovers are the next one's false result.
  if (info.freshProfile !== false) {
    // Best effort, never fatal. On Windows a browser that has only just been
    // killed can still hold its SQLite file for a moment, and a sweep that dies
    // with EBUSY before running anything is worse than one that runs against a
    // profile it could not clear — so this reports and carries on.
    try {
      rmSync(join(homedir(), 'AppData', 'Roaming', 'Slash-probe'), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 300
      })
    } catch (error) {
      console.log(`  (could not clear the probe profile: ${error.code ?? error}) `)
    }
  }

  return new Promise((resolve) => {
    console.log(`\n─── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`)
    const started = Date.now()

    const env = { ...process.env, [name]: '1' }
    // Electron runs as plain Node when this is set, so a shell that has it
    // exported turns every probe into a silent no-op. Deleted rather than set to
    // undefined, which Windows stringifies as "undefined".
    delete env.ELECTRON_RUN_AS_NODE

    const child = spawn(electronBinary(), ['out/main/index.js', '--profile=probe'], {
      cwd: root,
      env
    })

    let output = ''
    let finishing = null

    const stop = (why) => {
      if (finishing) return
      finishing = why
      child.kill()
    }

    const capture = (chunk) => {
      const text = String(chunk)
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.includes(name) || /VERDICT|RESULT:/i.test(line)) console.log(`  ${line.trim()}`)
      }
      // The probe has reported. Give it a moment to finish printing, then end it.
      if (/VERDICT|RESULT:/i.test(text) && !finishing) {
        setTimeout(() => stop('verdict'), VERDICT_GRACE_MS)
      }
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    const killer = setTimeout(() => {
      console.log(`  (no verdict after ${timeoutMs / 1000}s — stopping)`)
      stop('timeout')
    }, timeoutMs)

    child.on('error', (error) => {
      output += `\nfailed to start: ${String(error)}`
      stop('error')
    })

    child.on('close', () => {
      clearTimeout(killer)
      const seconds = Math.round((Date.now() - started) / 1000)
      const verdict = verdictOf(output)
      summary.push({ name, ...verdict, seconds })
      transcript.push(`===== ${name} (${seconds}s) =====\n${output}\n`)
      console.log(`  → ${verdict.label} (${seconds}s)`)
      resolve()
    })
  })
}

console.log(`Running ${requested.length} probe(s). Output: ${logPath}`)

for (const name of requested) {
  await run(name)
}

writeFileSync(logPath, transcript.join('\n'), 'utf8')

console.log(`\n${'═'.repeat(64)}`)
for (const row of summary) {
  const mark = row.ok ? '✓' : '·'
  console.log(`${mark} ${row.name.padEnd(34)} ${row.label.padEnd(16)} ${row.seconds}s`)
}
console.log(`${'═'.repeat(64)}`)
console.log(`Full output: ${logPath}`)

// A non-PASS is not necessarily a failure — INCONCLUSIVE means the probe could
// not test what it set out to — so this exits non-zero only on an explicit FAIL.
// Anything else is for a person to read.
const failed = summary.filter((row) => /FAIL/i.test(row.label))
if (failed.length > 0) {
  console.log(`\n${failed.length} probe(s) reported FAIL.`)
  process.exit(1)
}
