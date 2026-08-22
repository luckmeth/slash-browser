/**
 * Splitting an article for translation, and putting it back together.
 *
 * Pure, because the realignment step is where this feature can fail silently
 * and badly: if the reply comes back with a different number of blocks than went
 * out, naively zipping them produces an article whose paragraphs are shifted by
 * one — every sentence attached to the wrong heading, and nothing anywhere
 * saying so. That is far worse than refusing to translate.
 */

export interface Block {
  readonly kind: string
  readonly level: number
  readonly text: string
}

/**
 * Groups blocks into requests that fit a model's context.
 *
 * By character count rather than token count: tokenising properly would mean
 * shipping a tokeniser per provider, and the cost of being 20% wrong here is one
 * extra request, not a failure.
 *
 * A single block larger than the budget gets a chunk to itself rather than being
 * split. Cutting a paragraph in half mid-sentence and translating the pieces
 * separately produces two halves that do not join up.
 */
export function chunkBlocks(blocks: readonly Block[], maxChars: number): Block[][] {
  const chunks: Block[][] = []
  let current: Block[] = []
  let size = 0

  for (const block of blocks) {
    const cost = block.text.length + 8 // the marker line this block will carry
    if (current.length > 0 && size + cost > maxChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += cost
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Marker delimiting blocks in both directions. Unlikely in prose, and stable under translation. */
const MARKER = '<<<§'

/**
 * The text sent to the model.
 *
 * Numbered markers rather than JSON: models reliably preserve a short literal
 * marker, whereas asking for JSON invites unescaped quotes inside translated
 * prose and a parse failure on the whole batch.
 */
export function formatForTranslation(blocks: readonly Block[]): string {
  const body = blocks.map((block, index) => `${MARKER}${index}>>>\n${block.text}`).join('\n\n')
  // A terminator after the last block. Without it, any closing remark the model
  // adds ("Hope that helps!") lands inside the final paragraph, and the reader
  // gets the model chatter presented as part of the article.
  return `${body}\n\n${MARKER}${blocks.length}>>>\nEND`
}

/**
 * Reads the model's reply back into the same number of blocks, or fails.
 *
 * @returns one string per input block, or null if the reply cannot be trusted to
 *   line up. Null is the important case: a partial or shifted result would be
 *   presented as a translation of the article, and the reader would have no way
 *   to tell it apart from a correct one.
 */
export function parseTranslation(reply: string, expected: number): string[] | null {
  if (expected === 0) return []

  const found = new Map<number, string>()
  // Split on the markers, keeping the index that precedes each piece.
  const pattern = new RegExp(`${escapeRegExp(MARKER)}(\\d+)>>>`, 'g')

  const positions: { index: number; start: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(reply)) !== null) {
    positions.push({ index: Number(match[1]), start: match.index, end: pattern.lastIndex })
  }
  if (positions.length === 0) return null

  for (const [order, position] of positions.entries()) {
    const next = positions[order + 1]
    const text = reply.slice(position.end, next ? next.start : reply.length).trim()
    // A later duplicate of the same index wins; models occasionally restate a
    // marker, and the restatement is usually the corrected one.
    found.set(position.index, text)
  }

  // Anything at or beyond `expected` is the terminator and whatever followed
  // it — deliberately dropped rather than shown to the reader.
  const result: string[] = []
  for (let index = 0; index < expected; index += 1) {
    const text = found.get(index)
    // A missing block means the reply did not cover the article. Refusing is the
    // only honest answer — filling the gap with the original would present a
    // half-translated page as a translated one.
    if (text === undefined || text === '') return null
    result.push(text)
  }
  return result
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether translating this article is worth asking a provider about.
 *
 * Guards the obvious waste: an empty extraction, or one so short the request
 * costs more than it returns.
 */
export function worthTranslating(blocks: readonly Block[]): boolean {
  const characters = blocks.reduce((total, block) => total + block.text.trim().length, 0)
  return blocks.length > 0 && characters >= 40
}
