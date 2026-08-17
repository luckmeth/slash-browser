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

/** Ceiling on concurrent segments for one file. */
export const MAX_SEGMENTS = 8
/**
 * Below this, splitting costs more than it saves: each segment is a fresh
 * connection with its own handshake and its own slow-start.
 */
export const MIN_SEGMENT_BYTES = 2 * 1024 * 1024
