import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CHOICES,
  clampCopies,
  clampScale,
  countPages,
  parsePageRanges,
  toPdfOptions,
  toPrintOptions
} from './printOptions'

describe('parsePageRanges', () => {
  it('reads an empty string as every page', () => {
    expect(parsePageRanges('', 10)).toEqual([])
    expect(parsePageRanges('   ', 10)).toEqual([])
  })

  it('reads single pages and spans', () => {
    expect(parsePageRanges('1-3, 5', 10)).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 }
    ])
  })

  it('treats an open end as "to the last page"', () => {
    expect(parsePageRanges('8-', 10)).toEqual([{ from: 8, to: 10 }])
    expect(parsePageRanges('-3', 10)).toEqual([{ from: 1, to: 3 }])
  })

  it('clamps a span that runs past the document', () => {
    expect(parsePageRanges('8-99', 10)).toEqual([{ from: 8, to: 10 }])
  })

  it('merges overlapping and adjacent spans', () => {
    // Chromium honours an overlap by printing those pages twice, which is never
    // what "1-3, 2-5" means to the person who typed it.
    expect(parsePageRanges('1-3, 2-5', 10)).toEqual([{ from: 1, to: 5 }])
    expect(parsePageRanges('1-2, 3-4', 10)).toEqual([{ from: 1, to: 4 }])
  })

  it('sorts spans given out of order', () => {
    expect(parsePageRanges('7, 2', 10)).toEqual([
      { from: 2, to: 2 },
      { from: 7, to: 7 }
    ])
  })

  it('drops a single page beyond the document rather than failing the whole range', () => {
    expect(parsePageRanges('2, 99', 10)).toEqual([{ from: 2, to: 2 }])
  })

  it('returns null for anything it cannot read', () => {
    // Null means "print everything". Printing the wrong pages is worse than
    // printing all of them — only one of those wastes the user's time twice.
    expect(parsePageRanges('abc', 10)).toBeNull()
    expect(parsePageRanges('1-3,', 10)).toBeNull()
    expect(parsePageRanges('5-2', 10)).toBeNull()
    expect(parsePageRanges('0', 10)).toBeNull()
    expect(parsePageRanges('1.5', 10)).toBeNull()
  })

  it('returns null when the document has no pages', () => {
    expect(parsePageRanges('1', 0)).toBeNull()
  })
})

describe('countPages', () => {
  it('counts every page when no range is given', () => {
    expect(countPages([], 12)).toBe(12)
  })

  it('counts the pages inside the ranges', () => {
    expect(countPages([{ from: 1, to: 3 }, { from: 7, to: 7 }], 12)).toBe(4)
  })
})

describe('clampScale', () => {
  it('keeps a sensible value', () => {
    expect(clampScale(100)).toBe(100)
    expect(clampScale(55)).toBe(55)
  })

  it('clamps rather than rejecting, so a typo does not silently print at 100%', () => {
    expect(clampScale(5)).toBe(10)
    expect(clampScale(500)).toBe(200)
    expect(clampScale(Number.NaN)).toBe(100)
  })
})

describe('clampCopies', () => {
  it('never prints zero or a hundred copies by accident', () => {
    expect(clampCopies(0)).toBe(1)
    expect(clampCopies(1000)).toBe(99)
    expect(clampCopies(3)).toBe(3)
  })
})

describe('toPrintOptions', () => {
  it('omits pageRanges entirely when printing everything', () => {
    // An empty array reads as "no pages" to Chromium, and prints nothing at all.
    const options = toPrintOptions(DEFAULT_CHOICES, 10)
    expect('pageRanges' in options).toBe(false)
  })

  it('passes the ranges through when there are some', () => {
    const options = toPrintOptions({ ...DEFAULT_CHOICES, pageRangeText: '2-4' }, 10)
    expect(options.pageRanges).toEqual([{ from: 2, to: 4 }])
  })

  it('falls back to every page for an unreadable range', () => {
    const options = toPrintOptions({ ...DEFAULT_CHOICES, pageRangeText: 'nonsense' }, 10)
    expect('pageRanges' in options).toBe(false)
  })

  it('never prints silently', () => {
    // A print that starts with no dialog is a print nobody can cancel.
    expect(toPrintOptions(DEFAULT_CHOICES, 10).silent).toBe(false)
  })
})

describe('toPdfOptions', () => {
  it('converts the percent scale to the factor printToPDF expects', () => {
    // Passing the percent straight through renders the preview at a hundred
    // times actual size — one word per page.
    expect(toPdfOptions({ ...DEFAULT_CHOICES, scale: 100 }).scale).toBe(1)
    expect(toPdfOptions({ ...DEFAULT_CHOICES, scale: 50 }).scale).toBe(0.5)
  })

  it('clamps before converting', () => {
    expect(toPdfOptions({ ...DEFAULT_CHOICES, scale: 1000 }).scale).toBe(2)
  })
})
