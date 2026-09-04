/**
 * Messages between the main process and the embedding utility process.
 *
 * Deliberately narrow and deliberately plain data. The worker is the one place
 * in the browser that loads a machine-learning runtime, and it is given no way
 * to ask for anything: it receives text, it returns numbers. No file paths, no
 * URLs, no database handle.
 *
 * Kept free of zod and of anything importing electron so both sides can use it —
 * the worker bundle should not carry the schema library for four message shapes.
 */

/** main → worker */
export type WorkerRequest =
  | {
      readonly kind: 'prepare'
      readonly id: number
      readonly modelId: string
      /** Directory holding the bundled model files, keyed by model id. */
      readonly modelsDir: string
      /**
       * Vector width the caller's index is declared with.
       *
       * Passed in rather than imported so the worker knows nothing about our
       * schemas: importing the constant would drag zod and every type module
       * into a bundle whose entire job is to run one ONNX model.
       */
      readonly dimensions: number
    }
  | { readonly kind: 'embed'; readonly id: number; readonly texts: readonly string[] }
  | { readonly kind: 'shutdown'; readonly id: number }

/** worker → main */
export type WorkerResponse =
  | { readonly kind: 'ready'; readonly id: number }
  | {
      readonly kind: 'vectors'
      readonly id: number
      /** `count × dimensions`, row-major. One flat array keeps the copy to one. */
      readonly data: Float32Array
      readonly count: number
      readonly dimensions: number
    }
  | { readonly kind: 'failed'; readonly id: number; readonly message: string }

// There is deliberately no progress message. The model is shipped with the
// application and read from disk, so `prepare` either succeeds in about a second
// or fails — there is no download to report on.

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'ready' || kind === 'vectors' || kind === 'failed'
}
