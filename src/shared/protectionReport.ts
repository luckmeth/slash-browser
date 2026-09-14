/**
 * What Slash actually did this week.
 *
 * The spec this was built to says it plainly, and it is the right instinct:
 * never fabricate numbers, never invent savings, every metric must have a real
 * data source, and distinguish measured from estimated. So every line below
 * names where its figure came from, and a figure with no source does not appear
 * at all rather than appearing as a zero that looks like a measurement.
 *
 * In particular there is no "you saved 4 hours". Nothing in this browser
 * measures somebody's time, and a number like that would be an invention
 * dressed as a benefit — which is exactly the kind of claim that makes every
 * other number on the page untrustworthy.
 */

/** One day's counters, exactly as the database holds them. */
export interface ProtectionDay {
  readonly day: string
  readonly ads: number
  readonly trackers: number
  readonly popups: number
  readonly redirects: number
  readonly tabsHibernated: number
  readonly bytesFreed: number
  readonly duplicatesClosed: number
  readonly downloadsFlagged: number
  readonly sessionsRestored: number
  readonly tabsRestored: number
}

export const EMPTY_DAY: Omit<ProtectionDay, 'day'> = {
  ads: 0,
  trackers: 0,
  popups: 0,
  redirects: 0,
  tabsHibernated: 0,
  bytesFreed: 0,
  duplicatesClosed: 0,
  downloadsFlagged: 0,
  sessionsRestored: 0,
  tabsRestored: 0
}

/**
 * How a figure was arrived at.
 *
 * `measured` is a count of events that happened or bytes that were read.
 * `estimated` is a projection. Nothing here is currently estimated, and that is
 * worth keeping true — the label exists so that if a projected figure is ever
 * added it has to be marked rather than blending in.
 */
export type Confidence = 'measured' | 'estimated'

export interface ReportLine {
  readonly id: string
  /** The number, already in whatever unit `value` is expressed in. */
  readonly value: string
  readonly label: string
  /** Where the figure comes from, in one sentence. Always shown. */
  readonly source: string
  readonly confidence: Confidence
}

export interface ProtectionReport {
  /** Days that had any activity at all, newest first. */
  readonly days: readonly ProtectionDay[]
  readonly totals: Omit<ProtectionDay, 'day'>
  readonly lines: readonly ReportLine[]
  /** True when the week holds nothing worth reporting yet. */
  readonly empty: boolean
  /** How many days of records exist, so the page can say "since Tuesday". */
  readonly daysCovered: number
}

export const REPORT_WINDOW_DAYS = 7

export interface ReportInput {
  readonly days: readonly ProtectionDay[]
  /**
   * Permission requests refused in the window.
   *
   * Read from `permission_events` rather than counted again here, because that
   * table already records them with timestamps and a second tally is a second
   * thing that can disagree.
   */
  readonly permissionsDenied: number
}

export function buildProtectionReport(input: ReportInput): ProtectionReport {
  const totals = { ...EMPTY_DAY }
  for (const day of input.days) {
    totals.ads += day.ads
    totals.trackers += day.trackers
    totals.popups += day.popups
    totals.redirects += day.redirects
    totals.tabsHibernated += day.tabsHibernated
    totals.bytesFreed += day.bytesFreed
    totals.duplicatesClosed += day.duplicatesClosed
    totals.downloadsFlagged += day.downloadsFlagged
    totals.sessionsRestored += day.sessionsRestored
    totals.tabsRestored += day.tabsRestored
  }

  const lines: ReportLine[] = []
  const add = (
    id: string,
    count: number,
    label: (n: number) => string,
    source: string,
    confidence: Confidence = 'measured'
  ): void => {
    // A zero is not a result. A row reading "0 popups prevented" looks like a
    // measurement of an absence, when in fact nothing tried.
    if (count <= 0) return
    lines.push({ id, value: formatCount(count), label: label(count), source, confidence })
  }

  add(
    'ads',
    totals.ads,
    (n) => `${n === 1 ? 'advert' : 'adverts'} blocked`,
    'Requests the filter lists matched and the browser cancelled.'
  )
  add(
    'trackers',
    totals.trackers,
    (n) => `${n === 1 ? 'tracker' : 'trackers'} blocked`,
    'Requests to known tracking hosts, cancelled before they were sent.'
  )
  add(
    'popups',
    totals.popups,
    (n) => `${n === 1 ? 'pop-up' : 'pop-ups'} prevented`,
    'Windows a page tried to open without a click behind it.'
  )
  add(
    'redirects',
    totals.redirects,
    (n) => `${n === 1 ? 'redirect' : 'redirects'} stopped`,
    'Hops that Redirect X-Ray refused to follow.'
  )
  add(
    'permissions',
    input.permissionsDenied,
    (n) => `${n === 1 ? 'permission request' : 'permission requests'} refused`,
    'Recorded in the permission log at the moment each was answered.'
  )
  add(
    'downloads',
    totals.downloadsFlagged,
    (n) => `${n === 1 ? 'download' : 'downloads'} flagged`,
    'Files arriving with an extension Windows will run on a double-click. ' +
      'A caution, not a verdict — nothing here scans a file.'
  )
  add(
    'hibernated',
    totals.tabsHibernated,
    (n) => `${n === 1 ? 'tab' : 'tabs'} hibernated`,
    'Renderers destroyed, either by the performance engine or on your say-so.'
  )
  add(
    'duplicates',
    totals.duplicatesClosed,
    (n) => `duplicate ${n === 1 ? 'tab' : 'tabs'} closed`,
    'Second copies of a page you closed from Tab Health or the command centre.'
  )
  add(
    'restored',
    totals.tabsRestored,
    (n) => `${n === 1 ? 'tab' : 'tabs'} brought back`,
    'Tabs reopened from a restore point or a session.'
  )

  if (totals.bytesFreed > 0) {
    lines.push({
      id: 'bytes',
      value: formatBytesFreed(totals.bytesFreed),
      label: 'of memory released',
      // The one figure in the whole browser that is a measurement rather than a
      // projection, and it says so — see CLAUDE.md on why freezing never gets a
      // byte figure.
      source: 'The working set read immediately before each renderer was destroyed.',
      confidence: 'measured'
    })
  }

  return {
    days: [...input.days].sort((a, b) => (a.day < b.day ? 1 : -1)),
    totals,
    lines,
    empty: lines.length === 0,
    daysCovered: input.days.length
  }
}

function formatCount(count: number): string {
  return count.toLocaleString()
}

function formatBytesFreed(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return '<1 MB'
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * The local calendar day a moment falls in, as `YYYY-MM-DD`.
 *
 * Local rather than UTC: the report says "this week" to a person, and their
 * week is the one their clock is on. Built by hand rather than with
 * `toISOString`, which converts to UTC first and would file an evening in
 * London under the next day for half the year.
 */
export function localDay(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** The oldest day the report covers, as a `YYYY-MM-DD` bound for a query. */
export function windowStart(now: number, days = REPORT_WINDOW_DAYS): string {
  return localDay(now - (days - 1) * 24 * 60 * 60 * 1000)
}
