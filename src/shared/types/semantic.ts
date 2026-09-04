import { z } from 'zod'

/**
 * The optional local embedding layer.
 *
 * Everything here is off until the user turns it on. Keyword search is the
 * default and never depends on any of this — if the model will not load, or the
 * vector extension is missing, memory search still works exactly as before and
 * says so rather than failing.
 */

/**
 * Sentence-transformers MiniLM, the ONNX build.
 *
 * Chosen over anything larger because it is the only one whose cost is
 * invisible: ~25 MB on disk and a few milliseconds per passage on a CPU. A
 * browser cannot spend half a gigabyte and a GPU on making search slightly
 * better.
 *
 * Changing this id invalidates every stored vector — see `memory_embedded_pages.model`.
 */
export const SEMANTIC_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
export const SEMANTIC_MODEL_LABEL = 'MiniLM L6 (all-MiniLM-L6-v2)'
/** Vector width the model emits. The vec0 table is declared with exactly this. */
export const SEMANTIC_DIMENSIONS = 384
/**
 * Rounded on-disk size of the bundled weights.
 *
 * Stated in the interface not as a warning but as an accounting: the user paid
 * for this in installer size whether or not they ever switch the feature on, and
 * they are entitled to see what it cost them.
 */
export const SEMANTIC_MODEL_MB = 23

/**
 * MiniLM truncates at 256 word-pieces, so a passage much longer than this is
 * partly ignored by the model while still counting as "indexed" — which would be
 * a quiet lie about what is searchable.
 */
export const SEMANTIC_CHUNK_CHARS = 800
export const SEMANTIC_CHUNK_OVERLAP_CHARS = 120
/**
 * Chunks kept per page. A 40-minute longread would otherwise contribute a
 * hundred vectors and crowd every other page out of the nearest-neighbour
 * results. The UI states that it is the opening of a long page that is matched.
 */
export const SEMANTIC_MAX_CHUNKS_PER_PAGE = 10

/**
 * Cosine similarity below which a nearest neighbour is not a match.
 *
 * A vector index always returns its k nearest neighbours, however far away they
 * are — ask it about sourdough with only database articles indexed and it will
 * hand back database articles. Keyword search has the opposite and much better
 * behaviour: it returns nothing when nothing matches, and "nothing matched" is
 * information the user can act on. This floor restores that.
 *
 * Set low deliberately. MiniLM similarities between a short query and a passage
 * of an article sit far below what the number intuitively suggests — a genuinely
 * good match is often around 0.4 — so a higher threshold silently destroys
 * recall for exactly the paraphrased queries the feature exists to serve.
 */
export const SEMANTIC_MIN_SIMILARITY = 0.2

export const SemanticStateSchema = z.enum([
  /** sqlite-vec or the ONNX runtime is not usable in this build. */
  'unsupported',
  /** Available, switched off. */
  'off',
  /** Reading the bundled weights and building an ONNX session. About a second. */
  'preparing',
  /** Model loaded, working through pages that have no vectors yet. */
  'indexing',
  /** Model loaded, every eligible page embedded. */
  'ready',
  /** Something failed; `detail` says what. Keyword search is unaffected. */
  'error'
])
export type SemanticState = z.infer<typeof SemanticStateSchema>

export const SemanticStatusSchema = z.object({
  state: SemanticStateSchema,
  modelLabel: z.string(),
  dimensions: z.number().int(),
  /** Pages with current vectors. */
  embeddedPages: z.number().int(),
  /** Pages with text that are still waiting to be embedded. */
  pendingPages: z.number().int(),
  /**
   * Plain-language account of the state, composed in main.
   *
   * The renderer must never have to infer *why* semantic search is unavailable —
   * "not installed" and "your machine cannot run it" and "you turned it off" are
   * different facts and the user deserves the right one.
   */
  detail: z.string()
})
export type SemanticStatus = z.infer<typeof SemanticStatusSchema>

/**
 * The embedding runtime, behind an interface.
 *
 * One of the two Rust-migration seams named in the architecture notes. Every
 * method is asynchronous and takes plain data, so the in-process
 * `UtilityProcessEmbedder` can be swapped for a sidecar speaking JSON-RPC over
 * stdio without any caller changing.
 */
export interface EmbeddingWorker {
  /** Loads the model, downloading it on first use. Safe to call repeatedly. */
  prepare(): Promise<void>
  /** Mean-pooled, L2-normalised vectors — one per input, in input order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>
  /** Stops the runtime. The next `prepare()` starts it again. */
  dispose(): Promise<void>
}
