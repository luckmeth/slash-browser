import { z } from 'zod'

/**
 * Smart Download Guardian, and media detection.
 *
 * A page offering four "Download" buttons where one is real and three are ads is
 * the oldest trap on the web, and the browser is the only thing positioned to
 * notice. So this classifies what it can and **says how confident it is in
 * words**, because the one thing worse than no help is a confident wrong answer
 * that gets someone to run an installer.
 *
 * Nothing here declares a file safe. The vocabulary is deliberately hedged —
 * "appears", "based on detected signals", "consider scanning" — and every verdict
 * carries the signals it was based on so the user can disagree with it.
 */

export const LinkVerdictSchema = z.enum([
  /** Same site as the page, and shaped like a real download. */
  'likely-official',
  /** A real download, but hosted somewhere other than this site. */
  'third-party',
  /** Sits in advertising markup or points at a known ad network. */
  'advertisement',
  /** Signals disagree with each other in ways deceptive links usually do. */
  'suspicious'
])
export type LinkVerdict = z.infer<typeof LinkVerdictSchema>

export const DownloadCandidateSchema = z.object({
  url: z.string(),
  /** Visible text of the link, trimmed. */
  label: z.string(),
  host: z.string(),
  /** Extension inferred from the URL path, lowercase, without the dot. */
  extension: z.string().nullable(),
  verdict: LinkVerdictSchema,
  /**
   * Why this verdict, in plain language, most significant first.
   *
   * Shown in full rather than summarised into a score: "the link text says
   * Download but it points at a different site" is actionable, whereas "risk
   * 0.7" is not.
   */
  reasons: z.array(z.string())
})
export type DownloadCandidate = z.infer<typeof DownloadCandidateSchema>

export const DownloadScanSchema = z.object({
  pageUrl: z.string(),
  pageHost: z.string(),
  candidates: z.array(DownloadCandidateSchema),
  /** Set when the page was scanned but held nothing download-shaped. */
  note: z.string().nullable()
})
export type DownloadScan = z.infer<typeof DownloadScanSchema>

// --- media detection --------------------------------------------------------

export const MediaKindSchema = z.enum(['video', 'audio'])
export type MediaKind = z.infer<typeof MediaKindSchema>

export const MediaCandidateSchema = z.object({
  url: z.string(),
  kind: MediaKindSchema,
  /** Container from the URL or the source element's type attribute. */
  container: z.string().nullable(),
  /** Pixel dimensions where the page exposed them. */
  resolution: z.string().nullable(),
  /** Bytes, only when the server volunteered a length. */
  sizeBytes: z.number().int().nullable(),
  label: z.string()
})
export type MediaCandidate = z.infer<typeof MediaCandidateSchema>

export const MediaScanSchema = z.object({
  pageUrl: z.string(),
  candidates: z.array(MediaCandidateSchema),
  /**
   * Why nothing is downloadable, when nothing is.
   *
   * Required rather than optional. Media that is streamed, encrypted or served
   * through an adaptive manifest is not downloadable by this browser, and the
   * honest answer is a sentence saying so — not an empty list that looks like a
   * failure, and certainly not a button that cannot work.
   */
  note: z.string().nullable()
})
export type MediaScan = z.infer<typeof MediaScanSchema>

/**
 * Containers offered for direct download.
 *
 * Deliberately a short allowlist of plain progressive-download formats. Adaptive
 * manifests (`.m3u8`, `.mpd`), `blob:` sources and anything behind Encrypted
 * Media Extensions are **excluded by design**: reassembling those means working
 * around a platform's technical protections, which this browser does not do.
 */
export const DOWNLOADABLE_MEDIA_EXTENSIONS = [
  'mp4',
  'webm',
  'm4v',
  'mov',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wav',
  'flac'
] as const
