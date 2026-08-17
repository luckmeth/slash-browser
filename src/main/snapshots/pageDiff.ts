import { createHash } from 'node:crypto'

/**
 * Detecting that a watched page has meaningfully changed.
 *
 * Pure, because the hard part is not diffing — it is deciding what counts as a
 * change worth telling someone about. Almost every page differs on every load:
 * rotating adverts, "3 minutes ago", a session id, a carousel in a different
 * position. A watcher that reports all of it is indistinguishable from one that
 * reports nothing, because the user stops reading it.
 *
 * So the comparison happens on sentences after volatile fragments are stripped,
 * and price movements are singled out — they are the change people actually watch
 * a page for.
 */

/** Fragments that differ on every load and never mean anything. */
const VOLATILE_PATTERNS: readonly RegExp[] = [
  // Relative times: "3 minutes ago", "in 2 hours".
  /\b(?:in\s+)?\d+\s+(?:second|minute|hour|day|week|month|year)s?\s*(?:ago)?\b/gi,
  // Absolute clock times.
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
  // View and comment counters.
  /\b[\d,.]+\s*(?:views?|comments?|likes?|shares?|online|watching)\b/gi,
  // Cache-busting and session ids in visible text.
  /\b[0-9a-f]{16,}\b/gi
]

/** Prices, with the currency symbol or code kept so a change is legible. */
const PRICE_PATTERN =
  /(?:[$£€¥₹]|\b(?:USD|GBP|EUR|JPY|INR|AUD|CAD)\b)\s?\d[\d,]*(?:\.\d{1,2})?/gi

/**
 * Text reduced to what is worth comparing.
 *
 * Whitespace collapsed and volatile fragments removed, so a page whose only
 * difference is its clock is correctly reported as unchanged.
 */
export function normaliseForDiff(text: string): string {
  let output = text.replace(/\s+/g, ' ').trim()
  for (const pattern of VOLATILE_PATTERNS) output = output.replace(pattern, ' ')
  return output.replace(/\s+/g, ' ').trim()
}

/** Stable identity of a page's meaningful content. */
export function contentHash(text: string): string {
  return createHash('sha256').update(normaliseForDiff(text)).digest('hex').slice(0, 32)
}

/** Splits into sentence-ish units, which is the granularity a person reads. */
export function toSentences(text: string): string[] {
  return normaliseForDiff(text)
    .split(/(?<=[.!?])\s+|\s{2,}|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12)
}

export interface PriceChange {
  before: string
  after: string
}

/**
 * Price movements between two versions.
 *
 * Compared positionally: a page usually lists its prices in a stable order, so
 * the first price before corresponds to the first price after. When the *count*
 * changes the pairing is meaningless, so only the overlap is reported rather than
 * inventing correspondences.
 */
export function detectPriceChanges(before: string, after: string): PriceChange[] {
  const previous = normaliseForDiff(before).match(PRICE_PATTERN) ?? []
  const current = normaliseForDiff(after).match(PRICE_PATTERN) ?? []

  const changes: PriceChange[] = []
  for (let index = 0; index < Math.min(previous.length, current.length); index++) {
    const from = previous[index]!.replace(/\s+/g, '')
    const to = current[index]!.replace(/\s+/g, '')
    if (from !== to) changes.push({ before: from, after: to })
  }
  return changes
}

export interface TextDiff {
  added: string[]
  removed: string[]
  changed: boolean
}

/**
 * Sentences that appeared and disappeared.
 *
 * Set-based rather than positional: a paragraph moving up the page is not a
 * change to its content, and a line-by-line diff would report the whole document
 * as rewritten because one block shifted.
 */
export function diffText(before: string, after: string): TextDiff {
  const previous = new Set(toSentences(before))
  const current = new Set(toSentences(after))

  const added = [...current].filter((sentence) => !previous.has(sentence))
  const removed = [...previous].filter((sentence) => !current.has(sentence))
  return { added, removed, changed: added.length > 0 || removed.length > 0 }
}

/**
 * What changed, in plain language.
 *
 * Price movements lead, because they are the reason most people watch a page.
 * Removals are called out separately from additions: information *disappearing* —
 * a salary range, a deadline, a returns policy — is usually the more significant
 * event and the one a user would miss in a wall of added text.
 */
export function summariseChange(diff: TextDiff, prices: readonly PriceChange[]): string {
  const parts: string[] = []

  if (prices.length > 0) {
    parts.push(
      prices
        .slice(0, 3)
        .map((price) => `${price.before} → ${price.after}`)
        .join(', ')
    )
  }
  if (diff.removed.length > 0) {
    parts.push(`${diff.removed.length} passage${diff.removed.length === 1 ? '' : 's'} removed`)
  }
  if (diff.added.length > 0) {
    parts.push(`${diff.added.length} added`)
  }

  if (parts.length === 0) return 'No meaningful change.'
  return parts.join(' · ')
}

/**
 * Whether a difference is worth recording at all.
 *
 * A single added sentence on a long page is usually a rotating quote or a new
 * comment, so a floor applies — except for price changes, which matter however
 * small, and removals, which matter more than additions.
 */
export function isWorthReporting(diff: TextDiff, prices: readonly PriceChange[]): boolean {
  if (prices.length > 0) return true
  if (diff.removed.length > 0) return true
  return diff.added.length >= 3
}
