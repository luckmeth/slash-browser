import type { ParsedQuery } from '@shared/types/memory'

const DAY = 86_400_000

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
}

/**
 * Splits a natural-language query into search terms and a time window.
 *
 * Deliberately deterministic rather than model-driven. "The React article I read
 * last Tuesday" is the headline example for this feature, and it has to work
 * with AI switched off — which is the whole point of AI being optional. A rule
 * that handles the common phrasings is also faster and never hallucinates a date.
 *
 * `now` is injected so the whole thing is testable without freezing the clock.
 */
export function parseQuery(rawQuery: string, now: number = Date.now()): ParsedQuery {
  let text = ` ${rawQuery.toLowerCase().trim()} `
  let after: number | null = null
  let before: number | null = null
  let timeLabel: string | null = null

  const consume = (pattern: RegExp): boolean => {
    if (!pattern.test(text)) return false
    text = text.replace(pattern, ' ')
    return true
  }

  const startOfDay = (timestamp: number): number => {
    const date = new Date(timestamp)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }

  // Ordered most specific first: "last week" must not be eaten by "week".
  if (consume(/\btoday\b/)) {
    after = startOfDay(now)
    timeLabel = 'today'
  } else if (consume(/\byesterday\b/)) {
    after = startOfDay(now - DAY)
    before = startOfDay(now)
    timeLabel = 'yesterday'
  } else if (consume(/\blast night\b/)) {
    after = startOfDay(now - DAY) + 18 * 3600_000
    before = startOfDay(now) + 6 * 3600_000
    timeLabel = 'last night'
  } else if (consume(/\bthis week\b/)) {
    after = startOfDay(now) - new Date(now).getDay() * DAY
    timeLabel = 'this week'
  } else if (consume(/\blast week\b/)) {
    const thisWeekStart = startOfDay(now) - new Date(now).getDay() * DAY
    after = thisWeekStart - 7 * DAY
    before = thisWeekStart
    timeLabel = 'last week'
  } else if (consume(/\bthis month\b/)) {
    const date = new Date(now)
    after = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    timeLabel = 'this month'
  } else if (consume(/\blast month\b/)) {
    const date = new Date(now)
    after = new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime()
    before = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    timeLabel = 'last month'
  } else if (consume(/\bthis year\b/)) {
    after = new Date(new Date(now).getFullYear(), 0, 1).getTime()
    timeLabel = 'this year'
  } else {
    // "last tuesday" / "on tuesday" — the most recent one that has passed.
    const weekdayMatch = /\b(?:last|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(
      text
    )
    // Narrow the match itself, not a value derived from it — TS cannot carry a
    // null check through optional chaining back to the parent.
    if (weekdayMatch !== null) {
      const weekday = weekdayMatch[1] ?? ''
      const target = WEEKDAYS[weekday]
      if (target !== undefined) {
        const current = new Date(now).getDay()
        // Always look backwards: "last Tuesday" said on a Tuesday means the one
        // a week ago, not right now.
        let back = current - target
        if (back <= 0) back += 7
        const dayStart = startOfDay(now - back * DAY)
        after = dayStart
        before = dayStart + DAY
        timeLabel = `last ${weekday}`
        text = text.replace(weekdayMatch[0], ' ')
      }
    } else {
      // "3 days ago", "2 weeks ago", "6 months ago"
      const agoMatch = /\b(\d{1,3})\s*(day|days|week|weeks|month|months)\s*ago\b/.exec(text)
      if (agoMatch) {
        const amount = Number(agoMatch[1])
        const unit = agoMatch[2] ?? 'day'
        const spanDays = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 1
        const dayStart = startOfDay(now - amount * spanDays * DAY)
        after = dayStart
        // A window rather than an instant: nobody means one exact day when they
        // say "2 weeks ago".
        before = dayStart + (spanDays > 1 ? spanDays * DAY : DAY)
        timeLabel = `${amount} ${unit} ago`
        text = text.replace(agoMatch[0], ' ')
      }
    }
  }

  // Conversational filler that would otherwise be searched for literally.
  text = text.replace(
    /\b(?:find|show|me|the|that|a|an|i|read|saw|visited|was|looking|at|about|page|article|site|website|from|which|what|where|of|on|in|my)\b/g,
    ' '
  )

  return {
    terms: text.replace(/\s+/g, ' ').trim(),
    after,
    before,
    timeLabel
  }
}

/**
 * Escapes user input for an FTS5 MATCH expression.
 *
 * FTS5 treats bare punctuation as syntax, so an unescaped apostrophe or hyphen
 * raises a parse error rather than searching. Every token is quoted and given a
 * prefix wildcard so partial words still match while typing.
 */
export function toFtsQuery(terms: string): string {
  const tokens = terms
    .split(/\s+/)
    .map((token) => token.replace(/["*]/g, '').trim())
    .filter((token) => token.length > 0)

  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token}"*`).join(' AND ')
}
