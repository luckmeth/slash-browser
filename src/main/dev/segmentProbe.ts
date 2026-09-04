import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SegmentedDownload } from '../downloads/engine/SegmentedDownload'
import { planConnections } from '../downloads/engine/planning'
import { createLogger } from '../logger'

const log = createLogger('spike')

const MB = 1024 * 1024
/** Big enough to divide eight ways above the 2 MB floor, small enough to run in seconds. */
const TOTAL_BYTES = 32 * MB
const CONNECTIONS = 8
/** What the one bad connection is held to. Everything else is served flat out. */
const SLOW_BYTES_PER_SECOND = 2 * MB

/**
 * Does work-stealing actually make the download faster, and is the file still right?
 *
 * Dynamic segmentation is the one change in this engine that can corrupt a file
 * without failing anything. Segments hand each other byte ranges while both are
 * in flight; an off-by-one in the hand-off does not throw, does not fail a
 * request and does not stop the download reaching 100% — it writes a file with
 * a gap or a doubled region in the middle, which opens, plays for a while, and
 * is wrong. `segmentSplitting.test.ts` pins the arithmetic, but arithmetic
 * being right on paper is not the same as eight real connections racing over
 * one file handle.
 *
 * So this runs the **real `SegmentedDownload`** against a **real HTTP server**,
 * and it does not ask the engine whether it succeeded. It reads the file back
 * and compares a SHA-256 against the bytes the server holds.
 *
 * The speed claim is measured rather than asserted, and the fixture is built
 * for it. The server throttles exactly one thing: **the request that starts at
 * byte 0** — segment zero's connection, held to `SLOW_BYTES_PER_SECOND` for its
 * whole life. That is the scenario a static split handles worst and the only
 * one work-stealing exists for: one connection on a bad path while the other
 * seven finish and go idle.
 *
 * Under the old static split, segment zero owned `TOTAL_BYTES / CONNECTIONS`
 * bytes and nobody could help it, so the whole download could not finish sooner
 * than `(TOTAL_BYTES / CONNECTIONS) / SLOW_BYTES_PER_SECOND`. That number is
 * arithmetic from the fixture's own configuration, not a previous run, so it
 * needs no A/B and cannot drift. If the elapsed time comes in under it, the
 * other connections demonstrably took work off the slow one.
 */
export async function runSegmentProbe(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'slash-segment-'))
  const server = new Fixture()
  const origin = await server.start()

  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`segment probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  try {
    const destination = join(work, 'payload.bin')
    const download = new SegmentedDownload({
      url: `${origin}/payload.bin`,
      destination,
      connections: CONNECTIONS,
      onProgress: () => {}
    })

    const capabilities = await download.probe()
    check(
      'ranges',
      capabilities.acceptsRanges && capabilities.totalBytes === TOTAL_BYTES,
      `acceptsRanges=${capabilities.acceptsRanges} totalBytes=${capabilities.totalBytes}`
    )

    const plan = planConnections(capabilities, CONNECTIONS)
    check('connections', plan.connections === CONNECTIONS, `${plan.connections} planned — ${plan.note}`)

    const startedAt = Date.now()
    await download.run(capabilities.totalBytes, plan.connections)
    const elapsedMs = Date.now() - startedAt

    // ---- correctness, read back off the disk ------------------------------
    const written = await fs.readFile(destination)
    check('size', written.length === TOTAL_BYTES, `${written.length} bytes on disk of ${TOTAL_BYTES}`)
    const got = createHash('sha256').update(written).digest('hex')
    const want = createHash('sha256').update(server.payload).digest('hex')
    check(
      'checksum',
      got === want,
      got === want
        ? `SHA-256 matches the bytes the server holds (${got.slice(0, 16)}…)`
        : `got ${got.slice(0, 16)}… wanted ${want.slice(0, 16)}… — the file is corrupt, not merely incomplete`
    )
    check('first-mismatch', written.equals(server.payload), describeMismatch(written, server.payload))

    // ---- did stealing actually happen? ------------------------------------
    const segments = download.currentSegments
    check(
      'stealing',
      segments.length > plan.connections,
      `${segments.length} segments from ${plan.connections} initial — idle connections took ${segments.length - plan.connections} tails`
    )
    check(
      'coverage',
      coversExactly(segments, TOTAL_BYTES),
      `${segments.length} segments tile [0, ${TOTAL_BYTES}) with no gap and no overlap`
    )

    // ---- the speed claim ---------------------------------------------------
    const staticShare = Math.floor(TOTAL_BYTES / CONNECTIONS)
    const staticFloorMs = (staticShare / SLOW_BYTES_PER_SECOND) * 1000
    check(
      'faster-than-static',
      elapsedMs < staticFloorMs,
      `${(elapsedMs / 1000).toFixed(2)}s elapsed against a ${(staticFloorMs / 1000).toFixed(2)}s floor for a static split ` +
        `(the slow connection's ${(staticShare / MB).toFixed(1)} MB at ${SLOW_BYTES_PER_SECOND / MB} MB/s)`
    )
    check(
      'slow-connection-relieved',
      server.slowBytes < staticShare,
      `the throttled connection served ${(server.slowBytes / MB).toFixed(2)} MB; a static split would have made it serve ${(staticShare / MB).toFixed(2)} MB`
    )
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  } finally {
    await server.stop()
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }

  log.info(`segment probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}

/** Where the two buffers first differ, which is the only useful thing to print. */
function describeMismatch(got: Buffer, want: Buffer): string {
  const limit = Math.min(got.length, want.length)
  for (let at = 0; at < limit; at += 1) {
    if (got[at] !== want[at]) {
      return `first difference at byte ${at} (${(at / MB).toFixed(2)} MB in): got 0x${got[at]!.toString(16)}, wanted 0x${want[at]!.toString(16)}`
    }
  }
  return 'identical'
}

/** The invariant the unit tests assert, re-checked against what actually ran. */
function coversExactly(segments: readonly { start: number; end: number }[], total: number): boolean {
  const ordered = [...segments].sort((a, b) => a.start - b.start)
  let next = 0
  for (const part of ordered) {
    if (part.start !== next) return false
    if (part.end < part.start) return false
    next = part.end + 1
  }
  return next === total
}

/**
 * A range server with one deliberately bad connection.
 *
 * Only the request starting at byte 0 is throttled, and it stays throttled for
 * its whole life. That is segment zero under any split, so the fixture models
 * the exact case the old static split could not recover from.
 */
class Fixture {
  readonly payload: Buffer
  /** Bytes served down the throttled connection, which is the measurement. */
  slowBytes = 0
  private server: Server | null = null

  constructor() {
    // Deterministic and incompressible enough that a wrongly-ordered or
    // doubled region cannot coincidentally match. A repeating byte would make
    // an overlap bug invisible.
    this.payload = Buffer.alloc(TOTAL_BYTES)
    let state = 0x2545f491
    for (let at = 0; at < TOTAL_BYTES; at += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      this.payload[at] = state & 0xff
    }
  }

  start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    return new Promise((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
      })
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const range = /bytes=(\d+)-(\d+)?/.exec(request.headers.range ?? '')
    if (!range) {
      response.writeHead(200, {
        'content-length': String(TOTAL_BYTES),
        'accept-ranges': 'bytes',
        etag: '"probe"'
      })
      response.end(this.payload)
      return
    }

    const start = Number(range[1])
    const end = range[2] ? Number(range[2]) : TOTAL_BYTES - 1
    const slice = this.payload.subarray(start, end + 1)

    response.writeHead(206, {
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${end}/${TOTAL_BYTES}`,
      'accept-ranges': 'bytes',
      etag: '"probe"'
    })

    // The one-byte capability probe is not a transfer; never throttle it.
    const slow = start === 0 && slice.length > 1
    if (!slow) {
      response.end(slice)
      return
    }

    const chunk = 64 * 1024
    const perChunkMs = (chunk / SLOW_BYTES_PER_SECOND) * 1000
    for (let at = 0; at < slice.length; at += chunk) {
      if (response.destroyed) return
      const piece = slice.subarray(at, at + chunk)
      // `write` returning false means the socket buffered it; the bytes are
      // still ours to count, but a destroyed socket's are not — that was a real
      // measurement bug in the resume probe and it is worth not repeating.
      response.write(piece)
      this.slowBytes += piece.length
      await new Promise((resolve) => setTimeout(resolve, perChunkMs))
    }
    response.end()
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.closeAllConnections?.()
      this.server.close(() => resolve())
    })
  }
}
