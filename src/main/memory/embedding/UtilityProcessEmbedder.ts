import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { EmbeddingWorker } from '@shared/types/semantic'
import { SEMANTIC_DIMENSIONS, SEMANTIC_MODEL_ID } from '@shared/types/semantic'
import { createLogger } from '../../logger'
import { isWorkerResponse, type WorkerRequest, type WorkerResponse } from './protocol'

const log = createLogger('semantic')

/**
 * Reading ~23 MB from disk and building an ONNX session takes about a second.
 * A minute is generous enough for a cold cache on a slow disk while still
 * failing rather than leaving the UI on "loading…" forever.
 */
const PREPARE_TIMEOUT_MS = 60 * 1000
/** A warm batch takes single-digit milliseconds; seconds here means broken. */
const EMBED_TIMEOUT_MS = 60 * 1000

interface Pending {
  resolve: (response: WorkerResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * `EmbeddingWorker` over an Electron utility process.
 *
 * The seam the architecture notes reserve for a future Rust sidecar: the
 * interface is asynchronous and carries only text in and floats out, so
 * replacing this class with one that spawns a binary and speaks JSON-RPC over
 * stdio changes nothing above it.
 *
 * A crash is not fatal. The child dying settles every waiting call with a real
 * error and clears the state, and the next `prepare()` starts a fresh process —
 * semantic search comes back on its own rather than staying broken until restart.
 */
export class UtilityProcessEmbedder implements EmbeddingWorker {
  private child: UtilityProcess | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private ready = false
  private preparing: Promise<void> | null = null

  constructor(private readonly modelsDir: string) {}

  async prepare(): Promise<void> {
    if (this.ready) return
    if (this.preparing) return this.preparing

    this.preparing = (async () => {
      this.spawn()
      await this.send(
        {
          kind: 'prepare',
          id: 0,
          modelId: SEMANTIC_MODEL_ID,
          modelsDir: this.modelsDir,
          dimensions: SEMANTIC_DIMENSIONS
        },
        PREPARE_TIMEOUT_MS
      )
      this.ready = true
      log.info(`embedding model ready (${SEMANTIC_MODEL_ID})`)
    })()

    try {
      await this.preparing
    } catch (error) {
      // Leave nothing half-alive: a process that failed to load a model is not
      // going to succeed at embedding, and keeping it costs memory for nothing.
      this.teardown('the model failed to load')
      throw error
    } finally {
      this.preparing = null
    }
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.prepare()

    const response = await this.send({ kind: 'embed', id: 0, texts }, EMBED_TIMEOUT_MS)
    if (response.kind !== 'vectors') {
      throw new Error('The embedding worker returned an unexpected reply')
    }

    // One flat array arrives; slice it into rows without copying the floats
    // again — a page can produce ten vectors and this runs on every visit.
    const { data, count, dimensions } = response
    const vectors: Float32Array[] = []
    for (let index = 0; index < count; index++) {
      vectors.push(data.subarray(index * dimensions, (index + 1) * dimensions))
    }
    return vectors
  }

  async dispose(): Promise<void> {
    if (!this.child) return
    try {
      await this.send({ kind: 'shutdown', id: 0 }, 2_000)
    } catch {
      // A worker that will not answer a shutdown gets killed below. Nothing here
      // is worth reporting: we are trying to stop it either way.
    }
    this.teardown('shut down')
  }

  /** Whether the model is loaded and calls will not have to wait for a download. */
  get isReady(): boolean {
    return this.ready
  }

  private spawn(): void {
    if (this.child) return

    // Built as a separate rollup entry alongside index.js, so this resolves in
    // development and inside the asar identically.
    const entry = join(__dirname, 'embeddingWorker.js')
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'slash-embedding',
      // Inherited so the runtime's own warnings reach our log rather than being
      // swallowed — an ONNX load failure is otherwise completely silent.
      stdio: 'inherit'
    })
    this.child = child

    child.on('message', (raw: unknown) => {
      if (!isWorkerResponse(raw)) return
      const waiting = this.pending.get(raw.id)
      if (!waiting) return
      this.pending.delete(raw.id)
      clearTimeout(waiting.timer)
      if (raw.kind === 'failed') waiting.reject(new Error(raw.message))
      else waiting.resolve(raw)
    })

    child.on('exit', (code) => {
      // Only surprising exits are worth a warning; `dispose` clears the handle
      // first, so a deliberate shutdown does not log as a crash.
      if (this.child === child) {
        log.warn(`embedding worker exited unexpectedly (code ${code})`)
        this.teardown(`the worker stopped unexpectedly (exit code ${code})`)
      }
    })
  }

  private send(request: WorkerRequest, timeoutMs: number): Promise<WorkerResponse> {
    const child = this.child
    if (!child) return Promise.reject(new Error('The embedding worker is not running'))

    const id = this.nextId++
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The embedding worker did not respond in time'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.postMessage({ ...request, id })
    })
  }

  private teardown(reason: string): void {
    const child = this.child
    this.child = null
    this.ready = false
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
    }
    this.pending.clear()
    child?.kill()
  }
}
