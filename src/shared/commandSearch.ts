/**
 * Ranking for the command centre.
 *
 * One box that searches the browser: open tabs, recently closed ones, history,
 * bookmarks, the reading list, workspaces, snapshots, downloads, indexed page
 * text and the commands themselves. The hard part is not finding matches — it is
 * ordering them, because a query like `github` matches an open tab, forty
 * history rows and a bookmark, and only one of those answers "take me there".
 *
 * Pure and tested, so the ordering is a rule somebody decided rather than
 * whatever order the sources happened to load in.
 */

export type SourceKind =
  | 'command'
  | 'tab'
  | 'history'
  | 'bookmark'
  | 'reading'
  | 'workspace'
  | 'snapshot'
  | 'download'
  /** A tab that was closed and can be brought back. */
  | 'closed'
  /** A page matched on its indexed *text*, not its title. Opt-in, and off by default. */
  | 'memory'

export interface SearchableEntry {
  readonly id: string
  readonly kind: SourceKind
  /** What the row reads as — a title, or a command's name. */
  readonly label: string
  /** The second line: a host, a workspace, a filename. */
  readonly detail?: string
  /**
   * This row came back from a search that has already decided it matches.
   *
   * History and the page-text index are queried in SQLite, and SQLite is not
   * matching the same way this module does — FTS5 stems, so a query for
   * "running" returns a page containing "run". Re-scoring those here would drop
   * rows the search genuinely found, and the palette would quietly show fewer
   * results than were returned, which reads as the search being broken.
   *
   * They still *rank* last among equals, because a stem-only hit is a weaker
   * claim to being the answer than a title somebody can see the words in.
   */
  readonly alreadyMatched?: boolean
}

export interface ParsedQuery {
  /** A source the user narrowed to with `history:`, or null for everything. */
  readonly kind: SourceKind | null
  /** What is left after the filter is removed. */
  readonly terms: string
}

/**
 * Filters people actually type, including the plurals and short forms they
 * reach for first. `tab:` and `tabs:` both work because being made to guess
 * which one a browser wants is exactly the friction this is meant to remove.
 */
const FILTERS: Record<string, SourceKind> = {
  tab: 'tab',
  tabs: 'tab',
  history: 'history',
  h: 'history',
  bookmark: 'bookmark',
  bookmarks: 'bookmark',
  bm: 'bookmark',
  reading: 'reading',
  'reading-list': 'reading',
  read: 'reading',
  workspace: 'workspace',
  workspaces: 'workspace',
  ws: 'workspace',
  snapshot: 'snapshot',
  snapshots: 'snapshot',
  snap: 'snapshot',
  closed: 'closed',
  reopen: 'closed',
  download: 'download',
  downloads: 'download',
  command: 'command',
  commands: 'command',
  cmd: 'command',
  memory: 'memory',
  page: 'memory',
  text: 'memory'
}

export function parseCommandQuery(raw: string): ParsedQuery {
  const trimmed = raw.trimStart()
  const match = /^([a-z-]+):\s*/i.exec(trimmed)
  if (match) {
    const kind = FILTERS[match[1]!.toLowerCase()]
    // An unknown prefix is left alone rather than swallowed — somebody
    // searching for `note:` in a page title means those characters.
    if (kind) return { kind, terms: trimmed.slice(match[0].length).trim() }
  }
  return { kind: null, terms: trimmed.trim() }
}

/**
 * A subsequence match, for the way people actually type: `chgpt` for
 * "ChatGPT", `slbr` for "Slash Browser".
 *
 * Deliberately not a full edit-distance implementation. Levenshtein over every
 * history row on every keystroke is real work on the UI thread, and principle 1
 * does not allow that for a feature whose whole promise is feeling immediate.
 */
function subsequenceScore(haystack: string, needle: string): number | null {
  let index = 0
  let runs = 0
  let lastHit = -2

  for (const character of needle) {
    const found = haystack.indexOf(character, index)
    if (found === -1) return null
    // Consecutive characters are worth more than scattered ones, so "gith"
    // beats a word whose letters merely appear in order across the string.
    if (found !== lastHit + 1) runs += 1
    lastHit = found
    index = found + 1
  }

  // Fewer runs is a tighter match. Bounded so it can never reach the tiers
  // above it.
  return Math.max(1, 60 - runs * 6)
}

/**
 * Which kinds win a tie.
 *
 * An already-open tab outranks everything, because the answer to "I want
 * github" when github is open in tab three is to switch to tab three rather
 * than open a fourth copy of it. Commands come next: somebody who typed a
 * command's name meant the command.
 */
const KIND_BONUS: Record<SourceKind, number> = {
  tab: 40,
  command: 30,
  bookmark: 20,
  workspace: 15,
  snapshot: 12,
  reading: 10,
  closed: 8,
  history: 5,
  download: 2,
  // Last, and deliberately. A memory row matched somewhere in a page's *body*,
  // which is a far weaker claim to being the answer than a matching title.
  memory: 0
}

/**
 * How well an entry answers a query, or null when it does not.
 *
 * The tiers are ordered by how certain the match is, so an exact title always
 * beats a lucky substring however many terms it shares.
 */
export function scoreEntry(entry: SearchableEntry, terms: string): number | null {
  if (terms === '') return KIND_BONUS[entry.kind]

  const needle = terms.toLowerCase()
  const label = entry.label.toLowerCase()
  const detail = (entry.detail ?? '').toLowerCase()
  const bonus = KIND_BONUS[entry.kind]

  if (label === needle) return 1000 + bonus
  if (detail === needle) return 900 + bonus
  if (label.startsWith(needle)) return 800 + bonus
  if (detail.startsWith(needle)) return 700 + bonus

  // The start of any word — "release" should find "Slash Release Workflow"
  // without the user knowing the title begins with "Slash".
  if (new RegExp(`\\b${escapeRegExp(needle)}`).test(label)) return 600 + bonus
  if (label.includes(needle)) return 500 + bonus
  if (detail.includes(needle)) return 400 + bonus

  const fuzzy = subsequenceScore(label, needle)
  if (fuzzy !== null) return fuzzy + bonus

  return entry.alreadyMatched === true ? bonus : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type Ranked<T extends SearchableEntry> = T & { readonly score: number }
export type RankedEntry = Ranked<SearchableEntry>

/**
 * The rows to show, best first.
 *
 * Generic over the entry, so a caller can hang whatever it needs on a row — an
 * icon, the function to run — and get it back. The alternative is a second map
 * from id to behaviour, which is one more thing that can fall out of step with
 * the list it describes.
 *
 * Stable within a score so equal matches keep the order their source produced,
 * which for history means most-recent-first rather than an arbitrary shuffle
 * that changes between keystrokes.
 */
export function rankEntries<T extends SearchableEntry>(
  entries: readonly T[],
  raw: string,
  limit = 40
): Ranked<T>[] {
  const { kind, terms } = parseCommandQuery(raw)

  const ranked: Ranked<T>[] = []
  for (const entry of entries) {
    if (kind !== null && entry.kind !== kind) continue
    const score = scoreEntry(entry, terms)
    if (score === null) continue
    ranked.push({ ...entry, score })
  }

  // `sort` is stable in every engine this runs on, so equal scores keep source
  // order rather than being reshuffled on each keystroke.
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, limit)
}

/** A half-open `[start, end)` slice of a label that the query matched. */
export type MatchRange = readonly [number, number]

/**
 * Which characters of a label the query actually hit.
 *
 * Derived from the same rules `scoreEntry` uses rather than re-matched some
 * other way, so the highlight cannot disagree with the ranking — a row marked
 * up in a place the matcher did not look is worse than no highlight, because it
 * teaches the user a rule that is not true.
 */
export function matchRanges(text: string, terms: string): MatchRange[] {
  if (terms === '') return []

  const haystack = text.toLowerCase()
  const needle = terms.toLowerCase()

  // Every occurrence, not only the first: a title repeating the word looks
  // wrong with one of them marked and the others plain.
  if (haystack.includes(needle)) {
    const ranges: MatchRange[] = []
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      ranges.push([at, at + needle.length])
      from = at + needle.length
    }
    return ranges
  }

  // Otherwise it was a subsequence, so mark the characters it landed on —
  // merged where they are adjacent, or "ChatGPT" for `chgpt` renders as four
  // separate marks where it should read as two.
  const ranges: MatchRange[] = []
  let index = 0
  for (const character of needle) {
    const at = haystack.indexOf(character, index)
    if (at === -1) return []
    const last = ranges[ranges.length - 1]
    if (last && last[1] === at) ranges[ranges.length - 1] = [last[0], at + 1]
    else ranges.push([at, at + 1])
    index = at + 1
  }
  return ranges
}

/**
 * A label cut into its matched and unmatched pieces, in order.
 *
 * Returned rather than marked up here, because this module is shared and knows
 * nothing about how anything is rendered.
 */
export function splitOnMatches(
  text: string,
  terms: string
): { text: string; matched: boolean }[] {
  const ranges = matchRanges(text, terms)
  if (ranges.length === 0) return [{ text, matched: false }]

  const parts: { text: string; matched: boolean }[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), matched: false })
    parts.push({ text: text.slice(start, end), matched: true })
    at = end
  }
  if (at < text.length) parts.push({ text: text.slice(at), matched: false })
  return parts
}

/**
 * The filter to *show* for each source, and the order to show them in.
 *
 * `FILTERS` above accepts several spellings each; this is the one the UI
 * teaches, so there is a single place where the vocabulary is decided rather
 * than a hint row that can drift from what the parser accepts.
 */
export const SOURCE_FILTERS: readonly { prefix: string; kind: SourceKind }[] = [
  { prefix: 'tabs:', kind: 'tab' },
  { prefix: 'cmd:', kind: 'command' },
  { prefix: 'bm:', kind: 'bookmark' },
  { prefix: 'reading:', kind: 'reading' },
  { prefix: 'ws:', kind: 'workspace' },
  { prefix: 'snapshots:', kind: 'snapshot' },
  { prefix: 'closed:', kind: 'closed' },
  { prefix: 'history:', kind: 'history' },
  { prefix: 'downloads:', kind: 'download' },
  { prefix: 'page:', kind: 'memory' }
]

/** The heading each kind appears under. */
export const GROUP_LABEL: Record<SourceKind, string> = {
  tab: 'Open tabs',
  command: 'Commands',
  bookmark: 'Bookmarks',
  reading: 'Reading list',
  workspace: 'Workspaces',
  snapshot: 'Snapshots',
  closed: 'Recently closed',
  history: 'History',
  download: 'Downloads',
  memory: 'Page text'
}

/**
 * The ranked rows, split into their headings but keeping the overall order.
 *
 * A group appears where its best member ranked, so a query that strongly
 * matches a history row does not bury it under an empty-ish tab section.
 */
export function groupRanked<T extends SearchableEntry>(
  ranked: readonly Ranked<T>[]
): { kind: SourceKind; entries: Ranked<T>[] }[] {
  const groups = new Map<SourceKind, Ranked<T>[]>()
  for (const entry of ranked) {
    const bucket = groups.get(entry.kind)
    if (bucket) bucket.push(entry)
    else groups.set(entry.kind, [entry])
  }
  return [...groups.entries()].map(([kind, entries]) => ({ kind, entries }))
}
