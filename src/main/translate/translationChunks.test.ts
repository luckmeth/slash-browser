import { describe, it, expect } from 'vitest'
import {
  chunkBlocks,
  formatForTranslation,
  parseTranslation,
  worthTranslating,
  type Block
} from './translationChunks'

const block = (text: string, kind = 'paragraph'): Block => ({ kind, level: 1, text })

describe('chunkBlocks', () => {
  it('keeps everything in one chunk when it fits', () => {
    const blocks = [block('one'), block('two')]
    expect(chunkBlocks(blocks, 1000)).toEqual([blocks])
  })

  it('splits when the budget runs out', () => {
    const blocks = [block('a'.repeat(50)), block('b'.repeat(50)), block('c'.repeat(50))]
    const chunks = chunkBlocks(blocks, 120)
    // 50+8 each against a 120 budget: two fit, the third starts a new chunk.
    expect(chunks.length).toBe(2)
    expect(chunks.flat().length).toBe(3)
  })

  it('never splits a single block, however large', () => {
    // Cutting a paragraph mid-sentence and translating the halves separately
    // produces two halves that do not join up.
    const chunks = chunkBlocks([block('x'.repeat(5000))], 100)
    expect(chunks).toEqual([[block('x'.repeat(5000))]])
  })

  it('loses nothing', () => {
    const blocks = Array.from({ length: 30 }, (_, i) => block(`para ${i} ${'y'.repeat(40)}`))
    const chunks = chunkBlocks(blocks, 300)
    expect(chunks.flat().map((b) => b.text)).toEqual(blocks.map((b) => b.text))
  })

  it('gives no chunks for no blocks', () => {
    expect(chunkBlocks([], 100)).toEqual([])
  })
})

describe('formatForTranslation / parseTranslation', () => {
  const blocks = [block('Hello'), block('World'), block('Again')]

  it('round-trips a well-formed reply', () => {
    const sent = formatForTranslation(blocks)
    // A model returning the same markers with translated bodies.
    const reply = sent
      .replace('Hello', 'Bonjour')
      .replace('World', 'Monde')
      .replace('Again', 'Encore')
    expect(parseTranslation(reply, 3)).toEqual(['Bonjour', 'Monde', 'Encore'])
  })

  it('drops a closing remark that follows the terminator', () => {
    // formatForTranslation asks for a terminator after the last block. With it,
    // whatever the model adds afterwards is bounded and thrown away rather than
    // reaching the reader as the last paragraph of the article.
    const reply = [
      'Sure! Here you go:',
      '<<<§0>>>\nBonjour',
      '<<<§1>>>\nMonde',
      '<<<§2>>>\nEncore',
      '<<<§3>>>\nEND',
      'Hope that helps.'
    ].join('\n\n')
    expect(parseTranslation(reply, 3)).toEqual(['Bonjour', 'Monde', 'Encore'])
  })

  it('absorbs trailing chatter when the model omits the terminator', () => {
    // The known limit of a marker protocol against a model that ignores part of
    // the instruction. Recorded rather than hidden: the alternative is guessing
    // which trailing sentence is prose and which is chatter, and guessing wrong
    // silently truncates the article.
    const reply = [
      '<<<§0>>>\nBonjour',
      '<<<§1>>>\nMonde',
      'Hope that helps.'
    ].join('\n\n')
    expect(parseTranslation(reply, 2)?.[1]).toContain('Hope that helps.')
  })

  it('refuses a reply that is missing a block', () => {
    // Filling the gap with the original would present a half-translated article
    // as a translated one, and the reader could not tell.
    const reply = `<<<§0>>>\nBonjour\n\n<<<§2>>>\nEncore`
    expect(parseTranslation(reply, 3)).toBeNull()
  })

  it('refuses a reply with no markers at all', () => {
    // Naively zipping a prose reply against the blocks shifts every paragraph
    // onto the wrong heading, silently.
    expect(parseTranslation('Bonjour le monde', 3)).toBeNull()
  })

  it('refuses a reply with an empty block', () => {
    expect(parseTranslation('<<<§0>>>\n\n<<<§1>>>\nMonde', 2)).toBeNull()
  })

  it('takes the later of two markers with the same index', () => {
    // Models occasionally restate a marker; the restatement is usually the
    // corrected one.
    const reply = `<<<§0>>>\nfirst attempt\n\n<<<§0>>>\ncorrected`
    expect(parseTranslation(reply, 1)).toEqual(['corrected'])
  })

  it('returns an empty array for an empty article rather than failing', () => {
    expect(parseTranslation('anything', 0)).toEqual([])
  })
})

describe('worthTranslating', () => {
  it('says no to an empty or trivial extraction', () => {
    expect(worthTranslating([])).toBe(false)
    expect(worthTranslating([block('Hi')])).toBe(false)
  })

  it('says yes to a real article', () => {
    expect(worthTranslating([block('A sentence long enough to be worth sending somewhere.')])).toBe(true)
  })
})
