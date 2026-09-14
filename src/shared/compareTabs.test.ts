import { describe, it, expect } from 'vitest'
import { alignFacts, canonicalField, type PageFacts } from './compareTabs'

const page = (over: Partial<PageFacts> & { tabId: string }): PageFacts => ({
  url: 'https://shop.example/item',
  title: 'An item',
  description: null,
  siteName: null,
  fields: {},
  headings: [],
  wordCount: 100,
  ...over
})

describe('canonicalField', () => {
  it.each([
    ['price', 'Price'],
    ['Cost', 'Price'],
    ['RAM', 'RAM'],
    ['Memory', 'RAM'],
    ['system memory', 'RAM'],
    ['CPU', 'Processor'],
    ['screen size', 'Display'],
    ['ratingValue', 'Rating']
  ])('folds %s to %s', (input, expected) => {
    expect(canonicalField(input)).toBe(expected)
  })

  it('keeps a field it does not know, tidied', () => {
    // Guessing that two keys match because they share a word would put a
    // laptop's "screen size" beside a book's "size" and call it a comparison.
    expect(canonicalField('shipping weight class')).toBe('Shipping weight class')
  })

  it('drops a trailing colon from a table header', () => {
    expect(canonicalField('Weight:')).toBe('Weight')
  })
})

describe('alignFacts', () => {
  it('reports nothing when no page stated anything', () => {
    const result = alignFacts([page({ tabId: 'a' }), page({ tabId: 'b' })])
    expect(result.empty).toBe(true)
    expect(result.rows).toEqual([])
  })

  it('says "not detected" rather than filling a gap', () => {
    // The whole point: a cell is either what the page said or an admission.
    const result = alignFacts([
      page({ tabId: 'a', fields: { Price: '£999', RAM: '16 GB' } }),
      page({ tabId: 'b', fields: { Price: '£1,299' } })
    ])
    const ram = result.rows.find((row) => row.field === 'RAM')
    expect(ram?.cells).toEqual([
      { tabId: 'a', value: '16 GB' },
      { tabId: 'b', value: null }
    ])
  })

  it('aligns the same field written two ways', () => {
    const result = alignFacts([
      page({ tabId: 'a', fields: { Memory: '16 GB' } }),
      page({ tabId: 'b', fields: { RAM: '32 GB' } })
    ])
    expect(result.rows.filter((row) => row.field === 'RAM')).toHaveLength(1)
    expect(result.rows[0]?.stated).toBe(2)
  })

  it('marks a row where everybody answered and they disagree', () => {
    const result = alignFacts([
      page({ tabId: 'a', fields: { Price: '£999' } }),
      page({ tabId: 'b', fields: { Price: '£1,299' } })
    ])
    expect(result.rows[0]?.differs).toBe(true)
  })

  it('does not mark a row as differing when one page simply did not say', () => {
    // Silence is not disagreement, and highlighting it as one invents a
    // contrast the pages never drew.
    const result = alignFacts([
      page({ tabId: 'a', fields: { Price: '£999' } }),
      page({ tabId: 'b', fields: {} })
    ])
    expect(result.rows[0]?.differs).toBe(false)
  })

  it('does not mark agreement as a difference', () => {
    const result = alignFacts([
      page({ tabId: 'a', fields: { Brand: 'Acme' } }),
      page({ tabId: 'b', fields: { Brand: 'Acme' } })
    ])
    expect(result.rows[0]?.differs).toBe(false)
  })

  it('puts the rows everybody answered first', () => {
    const result = alignFacts([
      page({ tabId: 'a', fields: { Colour: 'Blue', Price: '£10' } }),
      page({ tabId: 'b', fields: { Price: '£20' } })
    ])
    expect(result.rows[0]?.field).toBe('Price')
  })

  it('leads with well-known fields among equals', () => {
    const result = alignFacts([
      page({ tabId: 'a', fields: { Aardvark: 'yes', Price: '£10' } }),
      page({ tabId: 'b', fields: { Aardvark: 'no', Price: '£20' } })
    ])
    expect(result.rows.map((row) => row.field)).toEqual(['Price', 'Aardvark'])
  })

  it('ignores a value long enough to be a paragraph', () => {
    // A table cell holding three sentences is prose that happened to sit in a
    // table, and putting it in a comparison column makes the table unreadable.
    const result = alignFacts([
      page({ tabId: 'a', fields: { Notes: 'x'.repeat(500) } }),
      page({ tabId: 'b', fields: {} })
    ])
    expect(result.empty).toBe(true)
  })

  it('ignores an empty value', () => {
    const result = alignFacts([page({ tabId: 'a', fields: { Price: '   ' } })])
    expect(result.empty).toBe(true)
  })

  it('collapses whitespace inside a value', () => {
    const result = alignFacts([page({ tabId: 'a', fields: { Price: '£999\n   each' } })])
    expect(result.rows[0]?.cells[0]?.value).toBe('£999 each')
  })

  it('takes a page’s first statement when it says a field twice', () => {
    // The second copy is usually a footer repeating the header.
    const result = alignFacts([
      page({ tabId: 'a', fields: { Price: '£999', price: '£1,999' } })
    ])
    expect(result.rows[0]?.cells[0]?.value).toBe('£999')
  })

  it('gives every page a cell, in the order they were passed', () => {
    const result = alignFacts([
      page({ tabId: 'a', fields: { Price: '£1' } }),
      page({ tabId: 'b' }),
      page({ tabId: 'c', fields: { Price: '£3' } })
    ])
    expect(result.rows[0]?.cells.map((cell) => cell.tabId)).toEqual(['a', 'b', 'c'])
  })

  it('compares more than two pages', () => {
    const result = alignFacts([
      page({ tabId: 'a', fields: { Price: '£1' } }),
      page({ tabId: 'b', fields: { Price: '£2' } }),
      page({ tabId: 'c', fields: { Price: '£3' } })
    ])
    expect(result.rows[0]?.stated).toBe(3)
    expect(result.rows[0]?.differs).toBe(true)
  })
})
