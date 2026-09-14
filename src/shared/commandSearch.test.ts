import { describe, it, expect } from 'vitest'
import {
  parseCommandQuery,
  rankEntries,
  scoreEntry,
  groupRanked,
  GROUP_LABEL,
  SOURCE_FILTERS,
  type SearchableEntry
} from './commandSearch'

const entry = (over: Partial<SearchableEntry> & { id: string }): SearchableEntry => ({
  kind: 'history',
  label: 'Untitled',
  ...over
})

describe('parseCommandQuery', () => {
  it('leaves an unfiltered query alone', () => {
    expect(parseCommandQuery('github')).toEqual({ kind: null, terms: 'github' })
  })

  it('reads a filter prefix', () => {
    expect(parseCommandQuery('history: react')).toEqual({ kind: 'history', terms: 'react' })
  })

  it.each([
    ['tab:', 'tab'],
    ['tabs:', 'tab'],
    ['h:', 'history'],
    ['bm:', 'bookmark'],
    ['ws:', 'workspace'],
    ['cmd:', 'command'],
    ['downloads:', 'download'],
    ['reading-list:', 'reading']
  ])('accepts %s as the short form people reach for', (prefix, kind) => {
    expect(parseCommandQuery(prefix + 'x').kind).toBe(kind)
  })

  it('takes a filter with nothing after it as "show me all of these"', () => {
    expect(parseCommandQuery('tabs:')).toEqual({ kind: 'tab', terms: '' })
  })

  it('leaves an unknown prefix in the search terms', () => {
    // Somebody searching for `note:` in a page title means those characters.
    // Swallowing every word before a colon would make them unsearchable.
    expect(parseCommandQuery('note:taking')).toEqual({ kind: null, terms: 'note:taking' })
  })

  it('does not eat the scheme off a pasted URL', () => {
    expect(parseCommandQuery('https://example.com/x')).toEqual({
      kind: null,
      terms: 'https://example.com/x'
    })
  })

  it.each(SOURCE_FILTERS)('parses $prefix, the filter the UI advertises', ({ prefix, kind }) => {
    // The hint row teaches these. A prefix shown to the user that the parser
    // does not accept is worse than no hint at all.
    expect(parseCommandQuery(prefix + 'anything').kind).toBe(kind)
  })

  it('advertises a filter for every source', () => {
    expect(new Set(SOURCE_FILTERS.map((f) => f.kind)).size).toBe(
      Object.keys(GROUP_LABEL).length
    )
  })
})

describe('scoreEntry', () => {
  it('ranks an exact title above a prefix, and a prefix above a substring', () => {
    const exact = scoreEntry(entry({ id: 'a', label: 'React' }), 'react')!
    const prefix = scoreEntry(entry({ id: 'b', label: 'React Router' }), 'react')!
    const inside = scoreEntry(entry({ id: 'c', label: 'Learning react at last' }), 'react')!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(inside)
  })

  it('finds the start of any word, not only the start of the title', () => {
    // "release" should find "Slash Release Workflow" without the user having to
    // know the title begins with "Slash".
    const word = scoreEntry(entry({ id: 'a', label: 'Slash Release Workflow' }), 'release')!
    const mid = scoreEntry(entry({ id: 'b', label: 'Prerelease notes' }), 'release')!
    expect(word).toBeGreaterThan(mid)
  })

  it('matches initials typed as a subsequence', () => {
    expect(scoreEntry(entry({ id: 'a', label: 'ChatGPT' }), 'chgpt')).not.toBeNull()
    expect(scoreEntry(entry({ id: 'b', label: 'Slash Browser' }), 'slbr')).not.toBeNull()
  })

  it('never lets a subsequence outrank a real substring', () => {
    // Otherwise a long title whose letters happen to appear in order would
    // displace the page that actually contains the word — and the subsequence
    // match is on the highest-ranked kind here, which is the hard case.
    const loose = scoreEntry(entry({ id: 'a', kind: 'tab', label: 'Git Hub tutorial' }), 'github')!
    const real = scoreEntry(entry({ id: 'b', kind: 'download', label: 'github.zip' }), 'github')!
    expect(real).toBeGreaterThan(loose)
  })

  it('returns null when nothing matches', () => {
    expect(scoreEntry(entry({ id: 'a', label: 'Hacker News' }), 'zzz')).toBeNull()
  })

  it('treats regex characters in the query as text', () => {
    // An unescaped `c++` is a syntax error, not a miss — the box would throw on
    // a keystroke rather than quietly find nothing.
    const row = entry({ id: 'a', label: 'learn c++ fast' })
    expect(() => scoreEntry(row, 'c++')).not.toThrow()
    expect(scoreEntry(row, 'c++')).not.toBeNull()
  })

  it('matches the host when the title does not', () => {
    const row = entry({ id: 'a', label: 'Home', detail: 'github.com' })
    expect(scoreEntry(row, 'github')).not.toBeNull()
  })
})

describe('rankEntries', () => {
  it('puts an already-open tab above history for the same page', () => {
    const ranked = rankEntries(
      [
        entry({ id: 'h', kind: 'history', label: 'GitHub' }),
        entry({ id: 't', kind: 'tab', label: 'GitHub' })
      ],
      'github'
    )
    // Switching to the tab is the answer; opening a fourth copy is not.
    expect(ranked[0]!.id).toBe('t')
  })

  it('narrows to one source when a filter is given', () => {
    const ranked = rankEntries(
      [
        entry({ id: 't', kind: 'tab', label: 'GitHub' }),
        entry({ id: 'h', kind: 'history', label: 'GitHub' })
      ],
      'history: github'
    )
    expect(ranked.map((r) => r.id)).toEqual(['h'])
  })

  it('lists a whole source when the filter has no terms', () => {
    const ranked = rankEntries(
      [
        entry({ id: 'a', kind: 'download', label: 'film.mp4' }),
        entry({ id: 'b', kind: 'download', label: 'notes.pdf' }),
        entry({ id: 'c', kind: 'tab', label: 'GitHub' })
      ],
      'downloads:'
    )
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('keeps source order between equal matches', () => {
    // History arrives most-recent-first, and a list that reshuffles itself
    // between keystrokes is unusable even when every row in it is relevant.
    const ranked = rankEntries(
      [
        entry({ id: '1', label: 'Docs' }),
        entry({ id: '2', label: 'Docs' }),
        entry({ id: '3', label: 'Docs' })
      ],
      'docs'
    )
    expect(ranked.map((r) => r.id)).toEqual(['1', '2', '3'])
  })

  it('drops everything that does not match', () => {
    const ranked = rankEntries(
      [entry({ id: 'a', label: 'GitHub' }), entry({ id: 'b', label: 'Hacker News' })],
      'github'
    )
    expect(ranked.map((r) => r.id)).toEqual(['a'])
  })

  it('honours the limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => entry({ id: String(i), label: 'Docs' }))
    expect(rankEntries(many, 'docs', 12)).toHaveLength(12)
  })

  it('shows something before a key is pressed', () => {
    const ranked = rankEntries(
      [
        entry({ id: 'd', kind: 'download', label: 'film.mp4' }),
        entry({ id: 't', kind: 'tab', label: 'GitHub' })
      ],
      ''
    )
    expect(ranked.map((r) => r.id)).toEqual(['t', 'd'])
  })
})

describe('groupRanked', () => {
  it('groups without reordering', () => {
    const groups = groupRanked(
      rankEntries(
        [
          entry({ id: 't1', kind: 'tab', label: 'GitHub' }),
          entry({ id: 'h1', kind: 'history', label: 'GitHub docs' }),
          entry({ id: 't2', kind: 'tab', label: 'GitHub issues' })
        ],
        'github'
      )
    )
    expect(groups.map((g) => g.kind)).toEqual(['tab', 'history'])
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['t1', 't2'])
  })

  it('is empty when nothing ranked', () => {
    expect(groupRanked([])).toEqual([])
  })
})
