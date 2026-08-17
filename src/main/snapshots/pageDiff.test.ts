import { describe, it, expect } from 'vitest'
import {
  contentHash,
  detectPriceChanges,
  diffText,
  isWorthReporting,
  normaliseForDiff,
  summariseChange,
  toSentences
} from './pageDiff'

describe('normaliseForDiff', () => {
  it('collapses whitespace', () => {
    expect(normaliseForDiff('a   b\n\nc')).toBe('a b c')
  })

  it('strips fragments that differ on every load', () => {
    // A watcher that reports the clock changing is one the user stops reading.
    expect(contentHash('Posted 3 minutes ago. Salary £50,000.')).toBe(
      contentHash('Posted 9 minutes ago. Salary £50,000.')
    )
    expect(contentHash('Updated at 14:32. Price $20')).toBe(
      contentHash('Updated at 22:07. Price $20')
    )
    expect(contentHash('1,204 views. Job open.')).toBe(contentHash('9,881 views. Job open.'))
  })

  it('strips session-like hex blobs', () => {
    expect(contentHash('token a3f9c1d4e5b60718 rest')).toBe(
      contentHash('token 0011223344556677 rest')
    )
  })

  it('does not strip a real number that matters', () => {
    // £50,000 is content. If normalisation ate it, a salary change would be
    // invisible — which is exactly what people watch a page for.
    expect(normaliseForDiff('Salary £50,000 per year')).toContain('£50,000')
  })
})

describe('contentHash', () => {
  it('is stable for the same meaningful content', () => {
    expect(contentHash('Hello   world')).toBe(contentHash('Hello world'))
  })

  it('differs when the content differs', () => {
    expect(contentHash('Salary £50,000')).not.toBe(contentHash('Salary £45,000'))
  })
})

describe('toSentences', () => {
  it('splits on sentence ends and drops fragments', () => {
    const sentences = toSentences('The role is remote. Salary is competitive. Ok.')
    expect(sentences).toContain('The role is remote.')
    // "Ok." is too short to be a meaningful unit of change.
    expect(sentences.some((s) => s === 'Ok.')).toBe(false)
  })
})

describe('detectPriceChanges', () => {
  it('reports a price movement with its currency', () => {
    expect(detectPriceChanges('Now £1,299.00 today', 'Now £1,499.00 today')).toEqual([
      { before: '£1,299.00', after: '£1,499.00' }
    ])
  })

  it('handles currency codes as well as symbols', () => {
    expect(detectPriceChanges('Costs USD 40', 'Costs USD 45')).toEqual([
      { before: 'USD40', after: 'USD45' }
    ])
  })

  it('says nothing when the price is unchanged', () => {
    expect(detectPriceChanges('£10 and £20', '£10 and £20')).toEqual([])
  })

  it('reports only the overlap when the count changes', () => {
    // Pairing a list of two against a list of five would invent changes.
    const changes = detectPriceChanges('£10 £20', '£11 £20 £30 £40 £50')
    expect(changes).toEqual([{ before: '£10', after: '£11' }])
  })

  it('handles a page with no prices', () => {
    expect(detectPriceChanges('no prices here', 'still none')).toEqual([])
  })
})

describe('diffText', () => {
  it('finds added and removed passages', () => {
    const before = 'The salary is £50,000 per year. Remote working is available.'
    const after = 'Remote working is available. Applications close on Friday.'
    const diff = diffText(before, after)

    expect(diff.removed.some((s) => s.includes('£50,000'))).toBe(true)
    expect(diff.added.some((s) => s.includes('Friday'))).toBe(true)
    expect(diff.changed).toBe(true)
  })

  it('does not report a moved paragraph as a change', () => {
    // A block shifting position is not a change to its content, and a positional
    // diff would report the whole page as rewritten.
    const before = 'First sentence here. Second sentence here.'
    const after = 'Second sentence here. First sentence here.'
    expect(diffText(before, after).changed).toBe(false)
  })

  it('reports no change for identical content', () => {
    expect(diffText('Same text entirely.', 'Same text entirely.').changed).toBe(false)
  })
})

describe('summariseChange', () => {
  it('leads with the price movement', () => {
    const summary = summariseChange({ added: ['a'], removed: [], changed: true }, [
      { before: '£10', after: '£12' }
    ])
    expect(summary.startsWith('£10 → £12')).toBe(true)
  })

  it('calls out removals separately from additions', () => {
    // Information disappearing — a salary, a deadline — is usually the more
    // significant event and would be lost in a count of added text.
    const summary = summariseChange({ added: ['a', 'b'], removed: ['c'], changed: true }, [])
    expect(summary).toContain('1 passage removed')
    expect(summary).toContain('2 added')
  })

  it('says so plainly when nothing changed', () => {
    expect(summariseChange({ added: [], removed: [], changed: false }, [])).toBe(
      'No meaningful change.'
    )
  })
})

describe('isWorthReporting', () => {
  it('always reports a price change, however small', () => {
    expect(isWorthReporting({ added: [], removed: [], changed: false }, [
      { before: '£10', after: '£10.50' }
    ])).toBe(true)
  })

  it('always reports a removal', () => {
    expect(isWorthReporting({ added: [], removed: ['gone'], changed: true }, [])).toBe(true)
  })

  it('ignores a single added sentence', () => {
    // Usually a rotating quote or a new comment, not a change to the page.
    expect(isWorthReporting({ added: ['one'], removed: [], changed: true }, [])).toBe(false)
  })

  it('reports several additions', () => {
    expect(isWorthReporting({ added: ['a', 'b', 'c'], removed: [], changed: true }, [])).toBe(true)
  })
})
