import {
  SEMANTIC_CHUNK_CHARS,
  SEMANTIC_CHUNK_OVERLAP_CHARS,
  SEMANTIC_MAX_CHUNKS_PER_PAGE
} from '@shared/types/semantic'

/**
 * Splitting a page into passages the model can actually read.
 *
 * Pure and clock-free so every rule here is unit-tested rather than observed by
 * running the browser and squinting at results.
 *
 * Two things decide the shape:
 *
 *  - **MiniLM truncates at 256 word-pieces.** Feeding it a whole article does
 *    not embed the article, it embeds the first paragraph and silently discards
 *    the rest. So the text is cut to passages the model reads in full.
 *  - **A vector is only useful if you can show what it matched.** Each chunk is
 *    stored verbatim, so a semantic hit can quote the passage rather than assert
 *    a similarity score at the user.
 */

export interface PageChunkSource {
  readonly title: string
  readonly siteName: string | null
  readonly excerpt: string
  readonly body: string
}

/**
 * Passages for one page, in document order.
 *
 * The first is always a header — title, site and excerpt — because a great many
 * queries are about what a page *is* ("that react auth article") rather than
 * about a sentence buried inside it. Without it, a page indexed with metadata
 * only would have no vector at all.
 */
export function chunkPage(page: PageChunkSource): string[] {
  const chunks: string[] = []

  const header = buildHeader(page)
  if (header !== '') chunks.push(header)

  const body = normaliseWhitespace(page.body)
  if (body !== '') {
    for (const passage of splitIntoPassages(body)) {
      if (chunks.length >= SEMANTIC_MAX_CHUNKS_PER_PAGE) break
      chunks.push(passage)
    }
  }

  return chunks
}

function buildHeader(page: PageChunkSource): string {
  const parts = [page.title, page.siteName ?? '', page.excerpt]
    .map(normaliseWhitespace)
    .filter((part) => part !== '')
  if (parts.length === 0) return ''
  // Deduplicated because siteName is very often already inside the title, and a
  // repeated phrase skews a mean-pooled vector towards itself.
  const seen = new Set<string>()
  const unique = parts.filter((part) => {
    const key = part.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return truncate(unique.join(' — '), SEMANTIC_CHUNK_CHARS)
}

/**
 * Fixed-width windows with an overlap.
 *
 * The overlap exists so a sentence spanning a boundary is not destroyed by it:
 * without it, the one passage that answers the query can end up as two halves,
 * neither of which means anything on its own.
 *
 * Windows are moved back to the nearest sentence or word boundary where one is
 * close enough, so a passage rarely starts mid-word.
 */
function splitIntoPassages(text: string): string[] {
  const passages: string[] = []
  let cursor = 0

  while (cursor < text.length && passages.length < SEMANTIC_MAX_CHUNKS_PER_PAGE) {
    const hardEnd = Math.min(cursor + SEMANTIC_CHUNK_CHARS, text.length)
    const end = hardEnd === text.length ? hardEnd : findBreak(text, cursor, hardEnd)
    const passage = text.slice(cursor, end).trim()
    // A window can come back empty only from runs of punctuation; skipping it is
    // right, but the cursor must still advance or this loops forever.
    if (passage.length > 0) passages.push(passage)
    if (end >= text.length) break
    cursor = Math.max(end - SEMANTIC_CHUNK_OVERLAP_CHARS, cursor + 1)
  }

  return passages
}

/**
 * The best place to cut, searching backwards from the hard limit.
 *
 * Only the last quarter of the window is considered: cutting a 800-character
 * passage down to 200 to land on a full stop trades far more context than the
 * tidiness is worth.
 */
function findBreak(text: string, start: number, hardEnd: number): number {
  const earliest = start + Math.floor(SEMANTIC_CHUNK_CHARS * 0.75)

  for (let index = hardEnd - 1; index > earliest; index--) {
    const character = text[index]
    if (character === '.' || character === '!' || character === '?' || character === '\n') {
      return index + 1
    }
  }
  for (let index = hardEnd - 1; index > earliest; index--) {
    if (text[index] === ' ') return index
  }
  return hardEnd
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`
}
