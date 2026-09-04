import { describe, it, expect } from 'vitest'
import {
  SEMANTIC_CHUNK_CHARS,
  SEMANTIC_MAX_CHUNKS_PER_PAGE
} from '@shared/types/semantic'
import { chunkPage } from './chunking'

const page = (overrides: Partial<Parameters<typeof chunkPage>[0]> = {}) =>
  chunkPage({ title: '', siteName: null, excerpt: '', body: '', ...overrides })

describe('chunkPage', () => {
  it('puts title, site and excerpt in the first passage', () => {
    const [header] = page({
      title: 'Scaling Postgres',
      siteName: 'Example Blog',
      excerpt: 'Partial indexes and when they help.'
    })
    expect(header).toBe('Scaling Postgres — Example Blog — Partial indexes and when they help.')
  })

  it('does not repeat the site name when the title already carries it', () => {
    const [header] = page({ title: 'Example Blog', siteName: 'Example Blog' })
    expect(header).toBe('Example Blog')
  })

  it('produces a header even when there is no body text', () => {
    // The metadata-only case: history indexing on, content indexing off. Without
    // this the page would have no vector at all and be invisible to semantic
    // search despite appearing in the index.
    expect(page({ title: 'Just a title' })).toEqual(['Just a title'])
  })

  it('returns nothing for a page with nothing on it', () => {
    expect(page()).toEqual([])
    expect(page({ title: '   ', body: '\n\n' })).toEqual([])
  })

  it('keeps passages within the model’s window', () => {
    const body = 'lorem ipsum dolor sit amet '.repeat(400)
    for (const chunk of page({ title: 'T', body })) {
      expect(chunk.length).toBeLessThanOrEqual(SEMANTIC_CHUNK_CHARS)
    }
  })

  it('overlaps consecutive passages so a split sentence survives', () => {
    const body = Array.from({ length: 300 }, (_, index) => `word${index}`).join(' ')
    const [, first, second] = page({ title: 'T', body })
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    // The second passage begins inside the first, so its opening words are
    // findable there. Without that, a sentence spanning the boundary is
    // destroyed by it and neither half means anything on its own.
    expect(first!).toContain(second!.slice(0, 40))
  })

  it('caps how much of a very long page is embedded', () => {
    const body = 'a sentence that goes on and on. '.repeat(5000)
    expect(page({ title: 'T', body }).length).toBeLessThanOrEqual(SEMANTIC_MAX_CHUNKS_PER_PAGE)
  })

  it('prefers to break at a sentence end', () => {
    const sentence = `${'x'.repeat(120)}. `
    const [, first] = page({ title: 'T', body: sentence.repeat(20) })
    expect(first!.endsWith('.')).toBe(true)
  })

  it('collapses whitespace so layout does not become content', () => {
    const [header] = page({ title: '  Spaced   \n out  ' })
    expect(header).toBe('Spaced out')
  })

  it('terminates on a body of pure punctuation', () => {
    // A window that trims to nothing must still advance the cursor, or this
    // never returns.
    expect(() => page({ title: 'T', body: '.'.repeat(5000) })).not.toThrow()
  })
})
