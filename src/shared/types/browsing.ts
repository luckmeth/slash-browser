import { z } from 'zod'

/**
 * A history row. One per URL, with a visit counter, rather than one row per
 * visit: the browser UI always wants "pages I've been to, most recent first",
 * and a per-visit log would need a GROUP BY on every read. Phase 6's Time Machine
 * keeps its own per-session snapshots, so nothing here needs visit-level detail.
 */
export const HistoryEntrySchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  faviconUrl: z.string().nullable(),
  visitCount: z.number().int(),
  lastVisitedAt: z.number()
})
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

export const BookmarkSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  faviconUrl: z.string().nullable(),
  /** null = top level. Folders are bookmarks with a null url. */
  parentId: z.number().int().nullable(),
  isFolder: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.number()
})
export type Bookmark = z.infer<typeof BookmarkSchema>

export const DownloadStateSchema = z.enum([
  'progressing',
  'paused',
  'completed',
  'cancelled',
  'interrupted'
])
export type DownloadState = z.infer<typeof DownloadStateSchema>

export const DownloadItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  filename: z.string(),
  savePath: z.string(),
  mimeType: z.string(),
  /** -1 when the server sends no Content-Length. */
  totalBytes: z.number().int(),
  receivedBytes: z.number().int(),
  state: DownloadStateSchema,
  /** True for extensions Windows will execute on double-click. */
  isDangerous: z.boolean(),
  startedAt: z.number(),
  completedAt: z.number().nullable()
})
export type DownloadItem = z.infer<typeof DownloadItemSchema>

/**
 * Extensions Windows treats as directly executable. A file arriving from the web
 * with one of these gets a warning before the user can open it.
 *
 * This is a caution, not a security boundary — it cannot detect a malicious PDF,
 * and the UI must not imply that anything not on this list is safe.
 */
export const EXECUTABLE_EXTENSIONS: readonly string[] = [
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'cpl', 'msc', 'jar', 'reg', 'lnk', 'inf',
  'dll', 'appx', 'msix', 'apk', 'sh'
]

export function isDangerousFilename(filename: string): boolean {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return false
  return EXECUTABLE_EXTENSIONS.includes(filename.slice(dot + 1).toLowerCase())
}
