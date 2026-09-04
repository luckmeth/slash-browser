import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadQueue } from '../downloads/engine/DownloadQueue'
import { expandBatch } from '../downloads/engine/batchUrls'
import { CATEGORY_FOLDERS } from '../downloads/engine/categoryFolders'
import type { QueueDefinition } from '../downloads/engine/queuePlanning'
import type { EngineDownload } from '@shared/types/downloadEngine'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The download-manager features, run against a real server and read back off disk.
 *
 * Every one of these is a claim about where bytes end up, and none of them is
 * verified by the engine reporting "completed" — that means the code finished,
 * not that the file is in the right place with the right contents. Category
 * sorting in particular writes to a folder that has never existed before, which
 * is a failure mode no unit test can reach.
 */
export async function runIdmProbe(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'slash-idm-'))
  const server = new Fixture()
  const origin = await server.start()

  let failures = 0
  const check = (name: string, passed: boolean, detail: string): void => {
    if (!passed) failures += 1
    log[passed ? 'info' : 'error'](`idm probe [${name}]: ${passed ? 'PASS' : 'FAIL'} — ${detail}`)
  }

  let queues: QueueDefinition[] = [
    { id: 'main', name: 'Main', maxConcurrent: 2, paused: false },
    { id: 'later', name: 'Later', maxConcurrent: 2, paused: true }
  ]
  const sortByCategory = true
  let latest: EngineDownload[] = []

  const queue = new DownloadQueue(
    () => work,
    () => 4,
    () => 0,
    (items) => {
      latest = items
    },
    undefined,
    () => queues,
    () => sortByCategory
  )

  const settle = async (predicate: () => boolean, ms = 20_000): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return true
      await delay(150)
    }
    return false
  }

  try {
    // ---- 1. batch expansion, then the files it names -----------------------
    const expansion = expandBatch(`${origin}/clip[1-4].mp4`)
    check(
      'batch-expands',
      expansion.urls.length === 4 && !expansion.error,
      `${expansion.urls.length} addresses — ${expansion.note}`
    )

    for (const url of expansion.urls) {
      queue.enqueue(url, { priority: 'normal', startAfter: null })
    }

    const done = await settle(
      () => latest.length === 4 && latest.every((item) => item.state === 'completed')
    )
    check(
      'batch-downloads',
      done,
      done
        ? 'all four completed'
        : `states: ${latest.map((item) => item.state).join(', ') || 'none'}`
    )

    // ---- 2. category sorting put them in a folder that did not exist -------
    const videoDir = join(work, CATEGORY_FOLDERS.video)
    const listed = await fs.readdir(videoDir).catch(() => [] as string[])
    check(
      'category-folder-created',
      listed.length === 4,
      listed.length === 4
        ? `${CATEGORY_FOLDERS.video}/ holds ${listed.sort().join(', ')} — a folder nothing had created before`
        : `expected 4 files in ${videoDir}, found ${listed.length}`
    )

    // The bytes, not the state. A file in the right folder can still be wrong.
    const first = await fs.readFile(join(videoDir, 'clip1.mp4')).catch(() => Buffer.alloc(0))
    check(
      'contents-correct',
      first.equals(server.payload),
      first.equals(server.payload)
        ? `clip1.mp4 is byte-for-byte what the server holds (${first.length} bytes)`
        : `clip1.mp4 is ${first.length} bytes, expected ${server.payload.length}`
    )

    // Nothing should have landed loose in the root while sorting was on.
    const loose = (await fs.readdir(work)).filter((entry) => entry.endsWith('.mp4'))
    check('nothing-unsorted', loose.length === 0, `${loose.length} file(s) left in the root`)

    // ---- 3. a paused queue holds its own downloads and nothing else --------
    server.slow = true
    const held = queue.enqueue(`${origin}/held.mp4`, {
      priority: 'normal',
      startAfter: null,
      queue: 'later'
    })
    const running = queue.enqueue(`${origin}/running.mp4`, {
      priority: 'normal',
      startAfter: null,
      queue: 'main'
    })

    await delay(2500)
    const heldRow = latest.find((item) => item.id === held)
    const runningRow = latest.find((item) => item.id === running)
    check(
      'paused-queue-holds',
      heldRow?.state === 'queued',
      `the download in the paused queue is "${heldRow?.state}"`
    )
    check(
      'other-queue-runs',
      runningRow !== undefined && runningRow.state !== 'queued',
      `the download in the running queue is "${runningRow?.state}" — a paused queue must not block another`
    )

    // ---- 4. resuming the queue releases exactly what it was holding --------
    queues = queues.map((entry) => (entry.id === 'later' ? { ...entry, paused: false } : entry))
    server.slow = false
    queue.resume(held)

    const released = await settle(
      () => latest.find((item) => item.id === held)?.state === 'completed'
    )
    check(
      'unpausing-releases',
      released,
      released
        ? 'the held download ran once its queue was resumed'
        : `still "${latest.find((item) => item.id === held)?.state}"`
    )
  } catch (error) {
    check('ran', false, error instanceof Error ? error.message : String(error))
  } finally {
    queue.dispose()
    await server.stop()
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }

  log.info(`idm probe: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}

/** Serves the same small payload under any name, with ranges. */
class Fixture {
  readonly payload = Buffer.from(
    Array.from({ length: 96 * 1024 }, (_, at) => (at * 31 + 7) & 0xff)
  )
  /** Holds responses open, so a "still queued" check has time to be true. */
  slow = false
  private server: Server | null = null

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
    if (this.slow) await delay(1200)

    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
    const total = this.payload.length
    if (!range) {
      response.writeHead(200, {
        'content-length': String(total),
        'accept-ranges': 'bytes',
        etag: '"idm"'
      })
      response.end(this.payload)
      return
    }

    const start = Number(range[1])
    const end = range[2] ? Number(range[2]) : total - 1
    const slice = this.payload.subarray(start, end + 1)
    response.writeHead(206, {
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      etag: '"idm"'
    })
    response.end(slice)
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.closeAllConnections?.()
      this.server.close(() => resolve())
    })
  }
}
