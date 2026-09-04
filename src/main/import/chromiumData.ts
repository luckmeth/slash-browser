/**
 * Reading Chromium's own data formats.
 *
 * Pure — no filesystem, no database — because every rule here is a detail of
 * someone else's file format that we can only get wrong silently. A bookmark
 * tree that loses a folder, or a timestamp that lands in 1601, is not something
 * you notice by using the feature once.
 */

/**
 * Chromium timestamps are microseconds since **1601-01-01 UTC** — the Windows
 * FILETIME epoch — not the Unix epoch. Read naively, every imported page claims
 * to have been visited in 1970, which then sorts the entire import to the bottom
 * of history where nobody will ever see it.
 */
const WINDOWS_TO_UNIX_EPOCH_MS = 11_644_473_600_000

export function chromeTimeToUnixMs(value: unknown): number | null {
  const micros = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(micros) || micros <= 0) return null

  const unixMs = Math.round(micros / 1000) - WINDOWS_TO_UNIX_EPOCH_MS
  // A negative result means the value was not a FILETIME at all. Better to admit
  // we do not know when a page was visited than to assert a date before the web.
  if (unixMs <= 0) return null
  // Guard the other end too: a corrupt row must not produce a bookmark dated
  // year 30000, which would pin itself to the top of every sorted list forever.
  if (unixMs > Date.now() + 365 * 24 * 60 * 60 * 1000) return null
  return unixMs
}

export interface ImportedBookmark {
  title: string
  /** null marks a folder. */
  url: string | null
  addedAt: number | null
  children: ImportedBookmark[]
}

/**
 * The roots of a Chromium `Bookmarks` file, as a tree we can walk.
 *
 * Chromium keeps three: the bar, "other", and synced/mobile. They are returned
 * as folders rather than flattened together — someone's bookmark bar is
 * organised, and dumping 400 links into one list destroys the only structure
 * they had.
 *
 * Every field is treated as untrusted. This is a JSON file in a directory the
 * user can edit, written by a program we do not control.
 */
export function readBookmarkRoots(parsed: unknown): ImportedBookmark[] {
  if (!isRecord(parsed)) return []
  const roots = parsed['roots']
  if (!isRecord(roots)) return []

  const labels: Record<string, string> = {
    bookmark_bar: 'Bookmarks bar',
    other: 'Other bookmarks',
    synced: 'Mobile bookmarks'
  }

  const result: ImportedBookmark[] = []
  for (const [key, label] of Object.entries(labels)) {
    const node = roots[key]
    if (!isRecord(node)) continue
    const folder = readNode(node, label)
    // An empty root is not worth an empty folder in someone's bookmarks.
    if (folder && countLinks(folder) > 0) result.push(folder)
  }
  return result
}

function readNode(node: Record<string, unknown>, fallbackName?: string): ImportedBookmark | null {
  const type = node['type']
  const name = typeof node['name'] === 'string' ? node['name'] : (fallbackName ?? '')
  const addedAt = chromeTimeToUnixMs(node['date_added'])

  if (type === 'url') {
    const url = node['url']
    if (typeof url !== 'string' || !isImportableUrl(url)) return null
    return { title: name || url, url, addedAt, children: [] }
  }

  // Anything that is not explicitly a url is treated as a folder, including the
  // roots themselves, which carry type "folder" in some versions and none at all
  // in others.
  const rawChildren = node['children']
  const children: ImportedBookmark[] = []
  if (Array.isArray(rawChildren)) {
    for (const child of rawChildren) {
      if (!isRecord(child)) continue
      const read = readNode(child)
      if (read) children.push(read)
    }
  }
  return { title: name, url: null, addedAt, children }
}

/**
 * Whether a URL is worth carrying across.
 *
 * `chrome://` and `edge://` pages are the other browser's internal screens and
 * do not exist here — importing them produces bookmarks that can only ever fail
 * to open. `javascript:` bookmarklets are refused outright: importing one would
 * put someone else's script one click away in our chrome.
 */
export function isImportableUrl(url: string): boolean {
  return /^(https?|ftp|file):/i.test(url)
}

/** Links in a subtree, ignoring folders. Used to skip empty roots. */
export function countLinks(node: ImportedBookmark): number {
  if (node.url !== null) return 1
  return node.children.reduce((total, child) => total + countLinks(child), 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
