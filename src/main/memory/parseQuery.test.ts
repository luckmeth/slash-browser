import { describe, it, expect } from 'vitest'
import { parseQuery, toFtsQuery } from './parseQuery'

// A Wednesday, midday.
const NOW = new Date('2026-08-12T12:00:00').getTime()
const parse = (query: string) => parseQuery(query, NOW)

function dayOf(timestamp: number): string {
  return new Date(timestamp).toDateString()
}

describe('parseQuery', () => {
  it('extracts terms when no time is mentioned', () => {
    const result = parse('postgresql scaling')
    expect(result.terms).toBe('postgresql scaling')
    expect(result.after).toBeNull()
    expect(result.timeLabel).toBeNull()
  })

  it('strips conversational filler', () => {
    // "Find the article about X I read" must search for X, not for "article".
    const result = parse('find the article about postgresql scaling I read')
    expect(result.terms).toBe('postgresql scaling')
  })

  it('handles today and yesterday', () => {
    expect(parse('today').timeLabel).toBe('today')
    expect(dayOf(parse('news yesterday').after!)).toBe(new Date('2026-08-11').toDateString())
    expect(parse('news yesterday').terms).toBe('news')
  })

  it('handles last week as the previous calendar week', () => {
    const result = parse('react auth last week')
    expect(result.timeLabel).toBe('last week')
    expect(result.terms).toBe('react auth')
    // Window ends where this week began.
    expect(result.before).toBeLessThanOrEqual(NOW)
    expect(result.after).toBeLessThan(result.before!)
  })

  it('handles last month', () => {
    const result = parse('postgres scaling last month')
    expect(result.timeLabel).toBe('last month')
    expect(new Date(result.after!).getMonth()).toBe(6) // July
    expect(new Date(result.before!).getMonth()).toBe(7) // August
  })

  it('resolves a named weekday to the most recent past one', () => {
    // Today is Wednesday; "last Tuesday" is yesterday.
    const result = parse('that react authentication article I read last tuesday')
    expect(result.timeLabel).toBe('last tuesday')
    expect(dayOf(result.after!)).toBe(new Date('2026-08-11').toDateString())
    expect(result.terms).toBe('react authentication')
  })

  it('looks backwards when the named weekday is today', () => {
    // Said on a Wednesday, "last Wednesday" means a week ago — not right now.
    const result = parse('notes last wednesday')
    expect(dayOf(result.after!)).toBe(new Date('2026-08-05').toDateString())
  })

  it('handles "N units ago"', () => {
    const days = parse('invoice 3 days ago')
    expect(days.timeLabel).toBe('3 days ago')
    expect(dayOf(days.after!)).toBe(new Date('2026-08-09').toDateString())
    expect(days.terms).toBe('invoice')

    const weeks = parse('2 weeks ago')
    expect(weeks.timeLabel).toBe('2 weeks ago')
    // A window, not an instant — nobody means one exact day.
    expect(weeks.before! - weeks.after!).toBeGreaterThan(86_400_000)
  })

  it('does not let "week" swallow "last week"', () => {
    expect(parse('last week').timeLabel).toBe('last week')
    expect(parse('this week').timeLabel).toBe('this week')
  })

  it('survives a query that is only time words', () => {
    const result = parse('yesterday')
    expect(result.terms).toBe('')
    expect(result.after).not.toBeNull()
  })
})

describe('toFtsQuery', () => {
  it('quotes tokens and adds a prefix wildcard', () => {
    expect(toFtsQuery('react auth')).toBe('"react"* AND "auth"*')
  })

  it('neutralises FTS5 syntax so punctuation cannot raise a parse error', () => {
    // An unescaped apostrophe or star would otherwise be read as syntax.
    expect(toFtsQuery(`o'brien`)).toBe(`"o'brien"*`)
    expect(toFtsQuery('foo* bar"')).toBe('"foo"* AND "bar"*')
  })

  it('returns empty for an empty query rather than a broken expression', () => {
    expect(toFtsQuery('')).toBe('')
    expect(toFtsQuery('   ')).toBe('')
  })
})
