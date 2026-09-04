import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadQueue } from '../downloads/engine/DownloadQueue'
import { Database } from '../db/Database'
import { EngineDownloadRepository } from '../db/repositories/EngineDownloadRepository'
import type { EngineDownload } from '@shared/types/downloadEngine'
import { createLogger } from '../logger'

const log = createLogger('spike')

/**
 * Does pause and resume actually continue, or does it start again?
 *
 * The engine reported "paused" and then "completed" and produced a correct
 * file, so nothing in the UI, the types or the unit tests could tell that
 * resuming threw away every byte already downloaded and fetched the whole file
 * a second time — into a *different* file, because `uniquePath` collided with
 * the partial one and appended " (1)".
 *
 * Only two things distinguish a real resume from a restart, and neither is
 * visible from inside the process:
 *
 *  - **how many bytes the server was asked for**, which this counts;
 *  - **which file the bytes ended up in**, which this checks by listing the
 *    directory rather than by trusting the record.
 *
 * So this runs the **real `DownloadQueue`** — not a mock, not a subclass —
 * against a **real HTTP server** that honours ranges, and reads the finished
 * file back with a checksum. Nothing here is stubbed except the clock-free
 * choice to serve the bytes slowly enough that there is a middle to pause in.
 */
export async function runResumeProbe(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'slash-resume-'))
  const server = new Fixture()
  const origin = await server.start()

  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`resume probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  try {
    await pauseAndContinue(work, origin, server, check)
    await cancelAfterResume(work, origin, server, check)
    await fileChangedUnderUs(work, origin, server, check)
    await flakySegments(work, origin, server, check)
    await resumeImmediately(work, origin, server, check)
    await survivesRestart(work, origin, server, check)
  } catch (error) {
    log.error(`resume probe: threw — ${error instanceof Error ? error.message : String(error)}`)
    failures += 1
  }

  server.stop()
  log.info(
    failures === 0
      ? 'resume probe: all checks passed'
      : `resume probe: ${failures} check(s) FAILED`
  )
  app.quit()
}

type Check = (name: string, passed: boolean, detail: string) => void

/** The size used throughout: big enough to have a middle, small enough to be quick. */
const FILE_BYTES = 8 * 1024 * 1024

/**
 * A queue of its own, pointed at a scratch directory.
 *
 * The real class with real dependencies — the point is to exercise the code
 * that ships, not a rehearsal of it. The bandwidth ceiling is what makes the
 * test possible at all: against a loopback server an 8 MB file finishes in
 * milliseconds, and a pause that lands after the download has ended proves
 * nothing.
 */
function makeQueue(directory: string): DownloadQueue {
  return new DownloadQueue(
    () => directory,
    () => 4,
    () => 400_000,
    () => {}
  )
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits for a predicate over the record, or gives up. */
async function until(
  queue: DownloadQueue,
  id: string,
  predicate: (record: EngineDownload) => boolean,
  timeoutMs = 60_000
): Promise<EngineDownload | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = queue.list().find((entry) => entry.id === id)
    if (record && predicate(record)) return record
    await delay(40)
  }
  return queue.list().find((entry) => entry.id === id) ?? null
}

const settled = (record: EngineDownload): boolean =>
  record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled'

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(path))
  return hash.digest('hex')
}

// --- 1. The headline: pause part-way, continue, and do not re-fetch ----------

async function pauseAndContinue(
  root: string,
  origin: string,
  server: Fixture,
  check: Check
): Promise<void> {
  const directory = join(root, 'continue')
  await fs.mkdir(directory, { recursive: true })
  const queue = makeQueue(directory)
  server.reset()

  const id = queue.enqueue(`${origin}/continue.bin`, { filename: 'film.bin' })

  // Far enough in that a restart would be obvious, early enough that there is
  // still most of a file to fetch.
  const partial = await until(queue, id, (r) => r.receivedBytes > FILE_BYTES * 0.25)
  check(
    'reached the middle',
    partial !== null && partial.receivedBytes > FILE_BYTES * 0.25,
    `${partial?.receivedBytes ?? 0} bytes of ${FILE_BYTES}`
  )

  queue.pause(id)
  const paused = await until(queue, id, (r) => r.state === 'paused')
  await delay(400) // let the aborted segment loops unwind and the table settle
  const heldBytes = queue.list().find((e) => e.id === id)?.receivedBytes ?? 0
  const pausedPath = paused?.savePath ?? ''
  const servedBeforeResume = server.served
  const requestsBeforeResume = server.requests.length

  check('pause reports paused', paused?.state === 'paused', `state=${paused?.state}`)
  check(
    'pause keeps the bytes it had',
    heldBytes > FILE_BYTES * 0.2,
    `${heldBytes} bytes held after pausing`
  )

  queue.resume(id)
  const done = await until(queue, id, settled, 90_000)

  check('resumes to completion', done?.state === 'completed', `state=${done?.state} error=${done?.error ?? 'none'}`)
  check(
    'destination did not change',
    done?.savePath === pausedPath,
    `${pausedPath} -> ${done?.savePath}`
  )

  // The claim that matters, and the only one a status code cannot make.
  const servedAfter = server.served - servedBeforeResume
  const shouldHaveFetched = FILE_BYTES - heldBytes

  // What was actually asked for after the resume, so a failure names the cause
  // instead of just the symptom.
  for (const request of server.requests.slice(requestsBeforeResume)) {
    log.info(
      `resume probe   after resume: ${request.path} bytes ${request.start}-${request.end} ` +
        `(sent ${request.sent})`
    )
  }
  check(
    'only the missing bytes were fetched',
    servedAfter < shouldHaveFetched * 1.25 + 1_000_000,
    `server sent ${servedAfter} after resume; ${shouldHaveFetched} were missing ` +
      `(a restart would be about ${FILE_BYTES})`
  )

  const files = readdirSync(directory)
  check(
    'no duplicate destination was created',
    files.length === 1,
    `directory holds ${JSON.stringify(files)}`
  )

  if (done?.savePath) {
    const digest = await sha256(done.savePath)
    const size = (await fs.stat(done.savePath)).size
    check('file is the right size', size === FILE_BYTES, `${size} bytes`)
    check(
      'file is byte-for-byte correct',
      digest === Fixture.expectedDigest,
      `sha256 ${digest.slice(0, 16)}…`
    )
  }

  queue.dispose()
}

// --- 2. Cancelling a resumed download ----------------------------------------

async function cancelAfterResume(
  root: string,
  origin: string,
  server: Fixture,
  check: Check
): Promise<void> {
  const directory = join(root, 'cancel')
  await fs.mkdir(directory, { recursive: true })
  const queue = makeQueue(directory)
  server.reset()

  const id = queue.enqueue(`${origin}/cancel.bin`, { filename: 'film.bin' })
  await until(queue, id, (r) => r.receivedBytes > FILE_BYTES * 0.2)
  queue.pause(id)
  await until(queue, id, (r) => r.state === 'paused')
  await delay(400)

  queue.resume(id)
  await until(queue, id, (r) => r.state === 'downloading')
  queue.cancel(id)

  const after = await until(queue, id, (r) => r.state === 'cancelled', 20_000)
  check('cancel after resume sticks', after?.state === 'cancelled', `state=${after?.state}`)

  // A cancelled download must stay cancelled. The old failure mode was the
  // aborted request surfacing as an error and the retry loop starting it again.
  await delay(3000)
  const later = queue.list().find((entry) => entry.id === id)
  check(
    'a cancelled download does not restart itself',
    later?.state === 'cancelled',
    `state three seconds later = ${later?.state}`
  )

  queue.dispose()
}

// --- 3. The file changed while we were paused --------------------------------

async function fileChangedUnderUs(
  root: string,
  origin: string,
  server: Fixture,
  check: Check
): Promise<void> {
  const directory = join(root, 'changed')
  await fs.mkdir(directory, { recursive: true })
  const queue = makeQueue(directory)
  server.reset()

  const id = queue.enqueue(`${origin}/changed.bin`, { filename: 'film.bin' })
  await until(queue, id, (r) => r.receivedBytes > FILE_BYTES * 0.2)
  queue.pause(id)
  await until(queue, id, (r) => r.state === 'paused')
  await delay(400)
  const pausedPath = queue.list().find((e) => e.id === id)?.savePath ?? ''

  // A different ETag means the bytes on the server are not the bytes we have.
  // Splicing them together would produce a corrupt file that looks finished.
  server.etag = '"v2"'
  queue.resume(id)
  const done = await until(queue, id, settled, 90_000)
  server.etag = '"v1"'

  check(
    'a changed file is downloaded again rather than spliced',
    done?.state === 'completed',
    `state=${done?.state} note=${done?.connectionNote}`
  )
  check(
    'starting again still uses the same destination',
    done?.savePath === pausedPath,
    `${pausedPath} -> ${done?.savePath}`
  )
  if (done?.savePath) {
    const digest = await sha256(done.savePath)
    check(
      'the restarted file is byte-for-byte correct',
      digest === Fixture.expectedDigest,
      `sha256 ${digest.slice(0, 16)}…`
    )
  }
  check(
    'no duplicate destination was created',
    readdirSync(directory).length === 1,
    `directory holds ${JSON.stringify(readdirSync(directory))}`
  )

  queue.dispose()
}

// --- 4. Segments that fail once --------------------------------------------

async function flakySegments(
  root: string,
  origin: string,
  server: Fixture,
  check: Check
): Promise<void> {
  const directory = join(root, 'flaky')
  await fs.mkdir(directory, { recursive: true })
  const queue = makeQueue(directory)
  server.reset()

  const id = queue.enqueue(`${origin}/flaky.bin`, { filename: 'flaky.bin' })
  const done = await until(queue, id, settled, 120_000)

  check(
    'a transfer that fails part-way still finishes',
    done?.state === 'completed',
    `state=${done?.state} attempts=${done?.attempts} error=${done?.error ?? 'none'}`
  )
  if (done?.state === 'completed' && done.savePath) {
    const digest = await sha256(done.savePath)
    check(
      'the retried file is byte-for-byte correct',
      digest === Fixture.expectedDigest,
      `sha256 ${digest.slice(0, 16)}…`
    )
    check(
      'retrying did not create a second file',
      readdirSync(directory).length === 1,
      `directory holds ${JSON.stringify(readdirSync(directory))}`
    )
  }

  queue.dispose()
}

// --- 5. Resume pressed before the paused transfer has stopped ----------------

/**
 * The race that made the first run of this probe fail.
 *
 * Pausing only asks the transfer to stop; its segment loops are asleep on the
 * bandwidth throttle and take a moment to notice. Pressing Resume in that
 * window used to start a **second** transfer, which downloaded the whole file
 * again from zero — and then the first one finally unwound and deleted the
 * second one's live entry on its way out.
 *
 * Nothing about it was visible from outside: the file was correct, the state
 * went paused then completed, and the only evidence was that the server had
 * been asked for two and a half files' worth of bytes.
 */
async function resumeImmediately(
  root: string,
  origin: string,
  server: Fixture,
  check: Check
): Promise<void> {
  const directory = join(root, 'immediate')
  await fs.mkdir(directory, { recursive: true })
  const queue = makeQueue(directory)
  server.reset()

  const id = queue.enqueue(`${origin}/immediate.bin`, { filename: 'film.bin' })
  await until(queue, id, (r) => r.receivedBytes > FILE_BYTES * 0.25)

  // No delay at all. This is the window.
  queue.pause(id)
  queue.resume(id)

  const done = await until(queue, id, settled, 90_000)
  check(
    'resume pressed immediately still completes',
    done?.state === 'completed',
    `state=${done?.state} error=${done?.error ?? 'none'}`
  )
  for (const request of server.requests) {
    log.info(
      `resume probe   immediate: bytes ${request.start}-${request.end} (sent ${request.sent})`
    )
  }
  check(
    'resume pressed immediately does not download the file twice',
    server.served < FILE_BYTES * 1.6,
    `server sent ${server.served} for an ${FILE_BYTES}-byte file`
  )
  check(
    'resume pressed immediately writes one file',
    readdirSync(directory).length === 1,
    `directory holds ${JSON.stringify(readdirSync(directory))}`
  )
  if (done?.savePath) {
    const digest = await sha256(done.savePath)
    check(
      'the file is still byte-for-byte correct',
      digest === Fixture.expectedDigest,
      `sha256 ${digest.slice(0, 16)}…`
    )
  }

  queue.dispose()
}

// --- 6. Surviving a restart --------------------------------------------------

/**
 * The real thing: quit mid-transfer, come back, continue.
 *
 * "Simulated" here means the queue and the repository are genuinely torn down
 * and rebuilt from a **real SQLite file on disk** — the same `Database` class,
 * the same migrations, the same repository the browser uses. What is not
 * simulated is the process exit itself, which would take the probe with it.
 * Everything the process exit would have destroyed is destroyed: the queue, its
 * in-memory maps, the live transfers and the connection to the database.
 *
 * Three claims, and the third is the one that used to be false in the docs:
 * the download is still in the list; it comes back **paused** rather than
 * silently resuming; and continuing it fetches only what is missing.
 */
async function survivesRestart(
  root: string,
  origin: string,
  server: Fixture,
  check: Check
): Promise<void> {
  const directory = join(root, 'restart')
  await fs.mkdir(directory, { recursive: true })
  const dataDir = join(root, 'restart-data')
  await fs.mkdir(dataDir, { recursive: true })
  server.reset()

  // --- the first "session" ---------------------------------------------------
  const firstDb = new Database(dataDir)
  firstDb.open()
  const firstRepo = new EngineDownloadRepository(firstDb)
  const firstQueue = new DownloadQueue(
    () => directory,
    () => 4,
    () => 400_000,
    () => {},
    firstRepo
  )

  const id = firstQueue.enqueue(`${origin}/restart.bin`, { filename: 'film.bin' })
  await until(firstQueue, id, (r) => r.receivedBytes > FILE_BYTES * 0.25)
  const beforeQuit = firstQueue.list().find((entry) => entry.id === id)
  const bytesAtQuit = beforeQuit?.receivedBytes ?? 0

  // Quitting. `dispose` is what the app calls on shutdown; the queue and every
  // map in it then go out of scope, exactly as they would on process exit.
  firstQueue.dispose()
  await delay(600)
  const servedAtQuit = server.served
  firstDb.close()

  check(
    'something was downloaded before the quit',
    bytesAtQuit > FILE_BYTES * 0.2,
    `${bytesAtQuit} bytes of ${FILE_BYTES} when Slash closed`
  )

  // --- the second "session" --------------------------------------------------
  const secondDb = new Database(dataDir)
  secondDb.open()
  const secondRepo = new EngineDownloadRepository(secondDb)
  const secondQueue = new DownloadQueue(
    () => directory,
    () => 4,
    () => 400_000,
    () => {},
    secondRepo
  )

  const saved = secondRepo.loadAll()
  check(
    'the download is still there after a restart',
    saved.length === 1 && saved[0]?.record.id === id,
    `${saved.length} download(s) loaded from ${saved.length > 0 ? 'the database' : 'nothing'}`
  )

  const outcome = secondQueue.restore(saved)
  check(
    'it is offered as continuable rather than started again',
    outcome.resumable === 1,
    `restored=${outcome.restored} resumable=${outcome.resumable}`
  )

  const afterRestore = secondQueue.list().find((entry) => entry.id === id)
  check(
    'a transfer interrupted by the quit comes back paused',
    afterRestore?.state === 'paused',
    `state=${afterRestore?.state} note=${afterRestore?.connectionNote}`
  )
  check(
    'it remembers how much it already had',
    (afterRestore?.receivedBytes ?? 0) >= bytesAtQuit * 0.9,
    `${afterRestore?.receivedBytes} bytes remembered, ${bytesAtQuit} were on disk`
  )
  check(
    'nothing started on its own',
    afterRestore?.state !== 'downloading' && afterRestore?.state !== 'probing',
    `state right after restore = ${afterRestore?.state}`
  )

  // --- and it continues ------------------------------------------------------
  const servedBeforeResume = server.served
  check(
    'restoring made no requests of its own',
    servedBeforeResume === servedAtQuit,
    `${servedBeforeResume - servedAtQuit} bytes fetched during restore`
  )

  secondQueue.resume(id)
  const done = await until(secondQueue, id, settled, 90_000)

  check(
    'a restored download completes when resumed',
    done?.state === 'completed',
    `state=${done?.state} error=${done?.error ?? 'none'}`
  )

  const servedAfter = server.served - servedBeforeResume
  const missing = FILE_BYTES - bytesAtQuit
  check(
    'a restored download fetches only what is missing',
    servedAfter < missing * 1.25 + 1_000_000,
    `server sent ${servedAfter} after the restart; ${missing} were missing ` +
      `(starting again would be about ${FILE_BYTES})`
  )
  check(
    'the restart did not create a second file',
    readdirSync(directory).length === 1,
    `directory holds ${JSON.stringify(readdirSync(directory))}`
  )
  if (done?.savePath) {
    const digest = await sha256(done.savePath)
    check(
      'the file that survived a restart is byte-for-byte correct',
      digest === Fixture.expectedDigest,
      `sha256 ${digest.slice(0, 16)}…`
    )
  }

  secondQueue.dispose()
  secondDb.close()
}

// --- the server --------------------------------------------------------------

/**
 * A real HTTP server that behaves like a CDN worth resuming from.
 *
 * Ranges, a strong validator, a declared length — and a **byte counter**, which
 * is the instrument the whole probe depends on. It also serves the bytes in
 * paced chunks: a loopback transfer that finishes instantly has no middle to
 * pause in, and a test that pauses a finished download passes for the wrong
 * reason.
 */
class Fixture {
  /** Deterministic content, so the checksum is a fixed constant. */
  static readonly content: Buffer = Buffer.from(
    Uint8Array.from({ length: FILE_BYTES }, (_unused, index) => index % 251)
  )
  static readonly expectedDigest: string = createHash('sha256')
    .update(Fixture.content)
    .digest('hex')

  /** Total payload bytes written to clients since the last reset. */
  served = 0
  /**
   * Every range asked for, in order.
   *
   * The byte counter says *that* something was re-fetched; only the list of
   * ranges says *what*. Fresh `planSegments` boundaries reappearing after a
   * resume means the transfer restarted; offsets part-way into a segment mean
   * it continued.
   */
  readonly requests: { path: string; start: number; end: number; sent: number }[] = []
  etag = '"v1"'

  private server: Server | null = null
  /** Ranges of `/flaky.bin` already refused once, so the retry can succeed. */
  private readonly refused = new Set<string>()

  reset(): void {
    this.served = 0
    this.requests.length = 0
    this.refused.clear()
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server?.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return `http://127.0.0.1:${port}`
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    const range = parseRange(request.headers['range'])

    if (path === '/flaky.bin' && range && range.end - range.start > 1) {
      // Refuse each distinct range exactly once. A permanent failure would only
      // prove the retry limit works; this proves the retry itself does.
      const key = `${range.start}-${range.end}`
      if (!this.refused.has(key)) {
        this.refused.add(key)
        response.writeHead(503, { 'content-length': '0' })
        response.end()
        return
      }
    }

    const headers: Record<string, string> = {
      'accept-ranges': 'bytes',
      etag: this.etag,
      'content-type': 'application/octet-stream',
      // Without this Chromium caches the response heuristically — an ETag and
      // no Cache-Control is enough — and a validator from one sub-test turned
      // up in the next one's probe. The engine then correctly refused to resume
      // against a file it thought had changed, and the probe blamed the engine.
      'cache-control': 'no-store'
    }

    const start = range?.start ?? 0
    const end = Math.min(range?.end ?? FILE_BYTES - 1, FILE_BYTES - 1)
    const slice = Fixture.content.subarray(start, end + 1)
    const entry = { path, start, end, sent: 0 }
    this.requests.push(entry)

    if (range) {
      headers['content-range'] = `bytes ${start}-${end}/${FILE_BYTES}`
      headers['content-length'] = String(slice.length)
      response.writeHead(206, headers)
    } else {
      headers['content-length'] = String(FILE_BYTES)
      response.writeHead(200, headers)
    }

    // Stop the moment the client goes away.
    //
    // `response.destroyed` alone is not enough and this mattered: when the
    // engine aborts a segment mid-stream, Node does not mark the response
    // destroyed for some time, so the server carried on writing the rest of the
    // file into a dead socket and *counted* it. The byte counter is the
    // instrument the whole probe reads, and it was measuring bytes nobody ever
    // received — making a correct resume look like it had downloaded the file
    // twice.
    let gone = false
    const stop = (): void => {
      gone = true
    }
    request.on('aborted', stop)
    request.on('close', stop)
    response.on('close', stop)

    // Paced, so there is a middle to pause in. 64 KB every 20 ms across four
    // connections is roughly 12 MB/s of server capacity — the engine's own
    // bandwidth ceiling is what actually sets the speed.
    const CHUNK = 64 * 1024
    for (let offset = 0; offset < slice.length; offset += CHUNK) {
      if (gone || response.destroyed || response.writableEnded) return
      const piece = slice.subarray(offset, offset + CHUNK)
      try {
        response.write(piece)
      } catch {
        return
      }
      this.served += piece.length
      entry.sent += piece.length
      await delay(20)
    }
    if (!gone && !response.destroyed) response.end()
  }
}

/** `bytes=0-1023` → `{ start: 0, end: 1023 }`. Open-ended ranges run to the end. */
function parseRange(header: string | string[] | undefined): { start: number; end: number } | null {
  const value = Array.isArray(header) ? header[0] : header
  const match = value ? /bytes=(\d+)-(\d*)/.exec(value) : null
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === '' || match[2] === undefined ? FILE_BYTES - 1 : Number(match[2])
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
}
