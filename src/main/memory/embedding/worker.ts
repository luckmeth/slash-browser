import type { WorkerRequest, WorkerResponse } from './protocol'

/**
 * The embedding utility process.
 *
 * This file is a separate build entry and runs in its own process, for one
 * reason above all others: loading an ONNX runtime and running a transformer
 * blocks whatever thread it is on for hundreds of milliseconds at a time. In the
 * main process that is the entire browser — every tab switch, every menu, every
 * IPC reply — stalling so search can be slightly better. That trade is not
 * available under "fast by default".
 *
 * It has no database access, no session, no window, and no network beyond
 * fetching the model itself on first run.
 */

type Embedder = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array | number[]; dims: number[] }>

let embedder: Embedder | null = null
let preparing: Promise<void> | null = null
/** Set by `prepare`; the width the caller's vector index is declared with. */
let expectedDimensions = 0

const port = process.parentPort

function reply(message: WorkerResponse): void {
  port.postMessage(message)
}

/**
 * Loads the model from the files shipped with the application.
 *
 * The in-flight promise is shared rather than re-entered: two `prepare` messages
 * arriving together — which is exactly what a double-click on the enable button
 * produces — must not load two copies of the weights.
 */
async function prepare(modelId: string, modelsDir: string): Promise<void> {
  if (embedder) return
  if (preparing) return preparing

  preparing = (async () => {
    const transformers = await import('@huggingface/transformers')

    // The model ships with the browser, so this is the only place it is read
    // from. `allowRemoteModels = false` is the load-bearing line: without it a
    // missing or corrupt file silently turns into an HTTP request to a third
    // party, which is precisely the behaviour a local-first search feature must
    // not have. A broken install should fail loudly instead.
    transformers.env.localModelPath = modelsDir
    transformers.env.allowLocalModels = true
    transformers.env.allowRemoteModels = false

    const pipe = await transformers.pipeline('feature-extraction', modelId, {
      // Quantised: a quarter of the size and a fraction of the memory, at a
      // similarity difference too small to change which page comes first. This
      // must match the file actually shipped — see resources/models/README.md.
      dtype: 'q8',
      // A background convenience must not compete with the renderer for cores.
      // Embedding a passage takes single-digit milliseconds on one thread.
      session_options: { intraOpNumThreads: 1 }
    })

    embedder = pipe as unknown as Embedder
  })()

  try {
    await preparing
  } finally {
    preparing = null
  }
}

interface EmbedResult {
  data: Float32Array
  count: number
  dimensions: number
}

async function embed(texts: readonly string[]): Promise<EmbedResult> {
  if (!embedder) throw new Error('The embedding model is not loaded')
  if (texts.length === 0) {
    return { data: new Float32Array(0), count: 0, dimensions: expectedDimensions }
  }

  const output = await embedder([...texts], { pooling: 'mean', normalize: true })
  const dimensions = output.dims[output.dims.length - 1] ?? 0
  const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data)

  if (dimensions !== expectedDimensions) {
    // The vec0 table is declared with a fixed width. A model that returns a
    // different one would produce vectors that silently never match anything,
    // which is worse than refusing.
    throw new Error(
      `Model returned ${dimensions}-dimensional vectors; this index stores ${expectedDimensions}`
    )
  }

  return { data, count: texts.length, dimensions }
}

port.on('message', (event: { data: WorkerRequest }) => {
  const request = event.data

  void (async () => {
    try {
      switch (request.kind) {
        case 'prepare':
          expectedDimensions = request.dimensions
          await prepare(request.modelId, request.modelsDir)
          reply({ kind: 'ready', id: request.id })
          break
        case 'embed': {
          const result = await embed(request.texts)
          reply({ kind: 'vectors', id: request.id, ...result })
          break
        }
        case 'shutdown':
          reply({ kind: 'ready', id: request.id })
          // Let the reply drain before the process goes away, or the caller's
          // promise never settles and its timeout is the only thing that ends it.
          setTimeout(() => process.exit(0), 50)
          break
      }
    } catch (error) {
      reply({
        kind: 'failed',
        id: request.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })()
})
