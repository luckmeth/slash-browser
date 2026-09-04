import { z } from 'zod'

/**
 * The advanced download engine.
 *
 * Electron's own `DownloadItem` is a single-connection, single-request affair
 * that cannot resume once the process exits. That is fine for a 200 KB PDF and
 * useless for a 4 GB ISO on a flaky connection, which is exactly when a download
 * manager earns its place. This engine drives HTTP itself so it can segment,
 * resume from disk, retry, queue and rate-limit.
 *
 * **It does not make every download faster, and the UI must not say it does.**
 * Segmenting helps only when the bottleneck is per-connection — a server that
 * throttles per socket, or a long fat pipe. When the server caps total bandwidth
 * per client, or refuses range requests, more connections change nothing.
 */

export const DownloadCategorySchema = z.enum([
  'video',
  'audio',
  'document',
  'software',
  'archive',
  'image',
  'other'
])
export type DownloadCategory = z.infer<typeof DownloadCategorySchema>

/**
 * What the server told us it can do, discovered before the transfer starts.
 *
 * Every capability here is *observed*, never assumed. A server that omits
 * `Accept-Ranges` is treated as unable to resume even if it secretly could,
 * because guessing wrong means a corrupt file rather than a slow one.
 */
export const ServerCapabilitiesSchema = z.object({
  /** Total bytes, or null when the server declines to say. */
  totalBytes: z.number().int().nullable(),
  /** Whether byte-range requests are supported. Required for segmenting. */
  acceptsRanges: z.boolean(),
  /** Filename from Content-Disposition, when offered. */
  suggestedName: z.string().nullable(),
  mimeType: z.string().nullable(),
  /** Validator for resuming safely — see `resumeIsSafe`. */
  etag: z.string().nullable(),
  lastModified: z.string().nullable()
})
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>

/** One contiguous byte range, and how much of it is already on disk. */
export const SegmentSchema = z.object({
  index: z.number().int(),
  start: z.number().int(),
  /** Inclusive, as HTTP Range is. */
  end: z.number().int(),
  receivedBytes: z.number().int()
})
export type Segment = z.infer<typeof SegmentSchema>

export const DownloadPrioritySchema = z.enum(['high', 'normal', 'low'])
export type DownloadPriority = z.infer<typeof DownloadPrioritySchema>

export const EngineDownloadStateSchema = z.enum([
  'queued',
  'probing',
  'downloading',
  'paused',
  'completed',
  'failed',
  'cancelled'
])
export type EngineDownloadState = z.infer<typeof EngineDownloadStateSchema>

export const EngineDownloadSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** Host it actually came from, which may differ after redirects. */
  sourceHost: z.string(),
  filename: z.string(),
  savePath: z.string(),
  category: DownloadCategorySchema,
  state: EngineDownloadStateSchema,
  priority: DownloadPrioritySchema,
  /**
   * The named queue this belongs to.
   *
   * Defaulted rather than required, so every download persisted before queues
   * existed parses straight back into the main queue and no migration is
   * needed for a field that is a label.
   */
  queue: z.string().default('main'),
  totalBytes: z.number().int().nullable(),
  receivedBytes: z.number().int(),
  /** Bytes per second over a short window, or 0 when not transferring. */
  bytesPerSecond: z.number().int(),
  /** Seconds remaining, or null when the total size is unknown. */
  secondsRemaining: z.number().int().nullable(),
  segments: z.array(SegmentSchema),
  /**
   * Why this download is or is not segmented, in plain language.
   *
   * Shown in the UI because "8 connections" beside a download that is actually
   * using one would be a lie, and the reason is genuinely useful: it is usually
   * the server's choice, not ours.
   */
  connectionNote: z.string(),
  /**
   * Held until this time before starting, or null to start as soon as a slot is
   * free. Lets a large transfer be pushed to off-peak hours.
   */
  startAfter: z.number().nullable(),
  attempts: z.number().int(),
  error: z.string().nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable()
})
export type EngineDownload = z.infer<typeof EngineDownloadSchema>

/**
 * Ceiling on concurrent segments for one file.
 *
 * Sixteen, not the eight it was and not the thirty-two IDM offers. Past about
 * sixteen the curve has flattened - the bottleneck has moved to the link or to
 * the server's per-client shaping - while the chance of being treated as abuse
 * has not. Servers that cap parallel connections per IP typically do it in the
 * eight-to-sixteen range, and being refused is slower than being polite.
 *
 * This is only the ceiling. `planConnections` still refuses to split a file
 * into pieces smaller than `MIN_SEGMENT_BYTES`, so a small file uses far fewer
 * however high this goes, and work-stealing means an over-generous number
 * costs nothing: connections that find nothing to steal simply retire.
 */
export const MAX_SEGMENTS = 16
/**
 * Below this, splitting costs more than it saves: each segment is a fresh
 * connection with its own handshake and its own slow-start.
 */
export const MIN_SEGMENT_BYTES = 2 * 1024 * 1024

/**
 * A download as it is written to disk, so it survives a quit.
 *
 * Deliberately a **superset** of `EngineDownload` rather than a replacement:
 * the record is what the UI renders and what travels over IPC, and the rest is
 * what the engine needs to pick the transfer up again. Keeping them apart means
 * the renderer never sees a request context, and no schema change here can
 * accidentally widen what the UI is handed.
 *
 * ## What is deliberately not here
 *
 * **No cookies, no credentials, no authorization headers.** A download that
 * needed a cookie is re-associated with its *session partition* by name and
 * asks Chromium's own cookie jar again — the same jar the page used. Copying
 * the cookie into a database row would put a live credential in a file that
 * outlives the tab it came from, to save one lookup.
 *
 * **Nothing from a private window.** Those downloads are not written at all.
 * A private session is in-memory by construction, and a row describing one
 * would outlive the window that was promised to leave no trace.
 */
export const PersistedDownloadSchema = z.object({
  /** Exactly what the UI shows, unchanged. */
  record: EngineDownloadSchema,
  /**
   * What the server said when the transfer began.
   *
   * Required to resume: `resumeIsSafe` compares this against a fresh probe, and
   * without the original validator there is no way to tell whether the bytes on
   * disk still belong to the file on the server.
   */
  capabilities: ServerCapabilitiesSchema.nullable(),
  /** The byte ranges and how much of each is already written. */
  segments: z.array(SegmentSchema),
  /**
   * Enough to reproduce the page's own request, and no more.
   *
   * `partition` is a session *name*, not a session: `persist:ws-…`, or
   * `default`. Restoring looks the partition up so cookies come from Chromium
   * rather than from us.
   */
  request: z.object({
    partition: z.string().nullable(),
    referer: z.string().nullable(),
    origin: z.string().nullable(),
    userAgent: z.string().nullable()
  }),
  /** The audio stream to join on completion, for a two-part download. */
  joinAudioUrl: z.string().nullable(),
  /** Whether the caller knew this address is a playlist. */
  isStream: z.boolean(),
  /** What a master playlist declared about the chosen quality. */
  streamHint: z
    .object({ bandwidth: z.number().nullable(), quality: z.string().nullable() })
    .nullable()
})
export type PersistedDownload = z.infer<typeof PersistedDownloadSchema>

/**
 * Where the queue keeps what it must not lose.
 *
 * An interface rather than the repository itself, so the engine stays a thing
 * that downloads files rather than a thing that knows about SQLite — and so the
 * queue can be constructed without a database at all, which is how every probe
 * and test uses it.
 */
export interface EngineDownloadStore {
  save(download: PersistedDownload): void
  remove(id: string): void
  clearFinished(): void
  loadAll(): PersistedDownload[]
}
