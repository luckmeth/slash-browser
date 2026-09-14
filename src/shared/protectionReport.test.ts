import { describe, it, expect } from 'vitest'
import {
  buildProtectionReport,
  localDay,
  windowStart,
  EMPTY_DAY,
  REPORT_WINDOW_DAYS,
  type ProtectionDay
} from './protectionReport'

const MB = 1024 * 1024

const day = (over: Partial<ProtectionDay> = {}): ProtectionDay => ({
  day: '2026-09-14',
  ...EMPTY_DAY,
  ...over
})

const report = (days: ProtectionDay[], permissionsDenied = 0) =>
  buildProtectionReport({ days, permissionsDenied })

describe('buildProtectionReport', () => {
  it('reports nothing on a browser that has done nothing', () => {
    const result = report([])
    expect(result.empty).toBe(true)
    expect(result.lines).toEqual([])
  })

  it('omits a metric that is zero rather than showing it', () => {
    // "0 pop-ups prevented" reads as a measurement of an absence, when in fact
    // nothing tried.
    const result = report([day({ ads: 12 })])
    expect(result.lines.map((line) => line.id)).toEqual(['ads'])
  })

  it('adds a week of days together', () => {
    const result = report([
      day({ day: '2026-09-12', ads: 10 }),
      day({ day: '2026-09-13', ads: 5 }),
      day({ day: '2026-09-14', ads: 1 })
    ])
    expect(result.totals.ads).toBe(16)
    expect(result.lines[0]?.value).toBe('16')
  })

  it('orders days newest first', () => {
    const result = report([
      day({ day: '2026-09-12', ads: 1 }),
      day({ day: '2026-09-14', ads: 1 }),
      day({ day: '2026-09-13', ads: 1 })
    ])
    expect(result.days.map((d) => d.day)).toEqual(['2026-09-14', '2026-09-13', '2026-09-12'])
  })

  it('gives every line a source sentence', () => {
    // A number with no stated source is the thing this module exists to avoid.
    const result = report(
      [
        day({
          ads: 1,
          trackers: 1,
          popups: 1,
          redirects: 1,
          tabsHibernated: 1,
          bytesFreed: MB,
          duplicatesClosed: 1,
          downloadsFlagged: 1,
          tabsRestored: 1
        })
      ],
      1
    )
    expect(result.lines).toHaveLength(10)
    for (const line of result.lines) {
      expect(line.source.length).toBeGreaterThan(20)
    }
  })

  it('marks released memory as measured', () => {
    const result = report([day({ bytesFreed: 2048 * MB })])
    const bytes = result.lines.find((line) => line.id === 'bytes')
    expect(bytes?.confidence).toBe('measured')
    expect(bytes?.value).toBe('2.0 GB')
    expect(bytes?.source).toContain('immediately before')
  })

  it('never claims hours saved', () => {
    // Nothing in this browser measures somebody's time, and a number like that
    // would make every other figure on the page untrustworthy.
    const result = report(
      [day({ ads: 900, trackers: 900, tabsHibernated: 40, bytesFreed: 4096 * MB })],
      10
    )
    const text = result.lines.map((line) => `${line.value} ${line.label} ${line.source}`).join(' ')
    expect(text).not.toMatch(/hour|minute|time saved|faster/i)
  })

  it('takes permission refusals from the permission log, not its own tally', () => {
    const result = report([day({ ads: 1 })], 3)
    const permissions = result.lines.find((line) => line.id === 'permissions')
    expect(permissions?.value).toBe('3')
    expect(permissions?.source).toContain('permission log')
  })

  it('calls a flagged download a caution rather than a verdict', () => {
    // Nothing here scans a file, and implying otherwise would be claiming a
    // capability this browser does not have.
    const result = report([day({ downloadsFlagged: 2 })])
    const line = result.lines.find((l) => l.id === 'downloads')
    expect(line?.source).toContain('not a verdict')
  })

  it('says how many days it covers', () => {
    const result = report([day({ day: '2026-09-13', ads: 1 }), day({ day: '2026-09-14', ads: 1 })])
    expect(result.daysCovered).toBe(2)
  })

  it('singularises every label at one', () => {
    const result = report(
      [
        day({
          ads: 1,
          trackers: 1,
          popups: 1,
          redirects: 1,
          tabsHibernated: 1,
          duplicatesClosed: 1,
          downloadsFlagged: 1,
          tabsRestored: 1
        })
      ],
      1
    )
    for (const line of result.lines) {
      expect(line.label, line.id).not.toMatch(/\b(adverts|trackers|pop-ups|redirects|tabs)\b/)
    }
  })
})

describe('localDay', () => {
  it('formats a moment as its local calendar day', () => {
    const at = new Date(2026, 8, 14, 13, 45).getTime()
    expect(localDay(at)).toBe('2026-09-14')
  })

  it('pads single-digit months and days', () => {
    const at = new Date(2026, 0, 5, 12, 0).getTime()
    expect(localDay(at)).toBe('2026-01-05')
  })

  it('uses the local day, not the UTC one', () => {
    // toISOString converts to UTC first, which would file a late evening under
    // the next day for anyone east of Greenwich and half the year in London.
    const lateEvening = new Date(2026, 8, 14, 23, 30)
    expect(localDay(lateEvening.getTime())).toBe('2026-09-14')
  })
})

describe('windowStart', () => {
  it('reaches back a week inclusive of today', () => {
    const now = new Date(2026, 8, 14, 12, 0).getTime()
    expect(windowStart(now)).toBe('2026-09-08')
  })

  it('covers exactly REPORT_WINDOW_DAYS days', () => {
    const now = new Date(2026, 8, 14, 12, 0).getTime()
    const start = new Date(`${windowStart(now)}T00:00:00`)
    const today = new Date(`${localDay(now)}T00:00:00`)
    const span = Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1
    expect(span).toBe(REPORT_WINDOW_DAYS)
  })
})
