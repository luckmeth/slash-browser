/**
 * Turning what the preview screen shows into what Chromium is asked to print.
 *
 * Pure, because the failure mode is expensive in a way tests are cheap: a page
 * range parsed wrongly does not throw, it prints the wrong pages — on paper,
 * after the user has left the room.
 */

export interface PageRange {
  readonly from: number
  readonly to: number
}

export type PaperSize = 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid'

export interface PrintChoices {
  readonly landscape: boolean
  readonly paperSize: PaperSize
  /** Percent. 100 is actual size. */
  readonly scale: number
  readonly printBackground: boolean
  readonly headerFooter: boolean
  readonly copies: number
  /** Empty means every page. */
  readonly pageRangeText: string
}

export const DEFAULT_CHOICES: PrintChoices = {
  landscape: false,
  paperSize: 'A4',
  scale: 100,
  // Off, matching every other browser. Backgrounds turn a readable article into
  // a solid block of toner, and the person who wants them knows they do.
  printBackground: false,
  headerFooter: false,
  copies: 1,
  pageRangeText: ''
}

/**
 * `"1-3, 5, 8-"` against a 10-page document → `[{1,3},{5,5},{8,10}]`.
 *
 * Returns null for anything it cannot read, so the caller prints everything
 * rather than guessing — printing the wrong pages is worse than printing all of
 * them, because only one of those wastes the user's time twice.
 *
 * Ranges are clamped to the document and merged when they overlap. Chromium
 * accepts overlapping ranges by printing pages twice, which nobody means.
 */
export function parsePageRanges(text: string, pageCount: number): PageRange[] | null {
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (pageCount < 1) return null

  const parts = trimmed.split(',').map((part) => part.trim())
  const ranges: PageRange[] = []

  for (const part of parts) {
    if (part === '') return null

    const match = /^(\d*)\s*-\s*(\d*)$/.exec(part)
    if (match) {
      const rawFrom = match[1] === '' ? 1 : Number(match[1])
      const rawTo = match[2] === '' ? pageCount : Number(match[2])
      if (!Number.isInteger(rawFrom) || !Number.isInteger(rawTo)) return null
      if (rawFrom < 1 || rawTo < 1) return null
      if (rawFrom > rawTo) return null
      ranges.push({ from: Math.min(rawFrom, pageCount), to: Math.min(rawTo, pageCount) })
      continue
    }

    if (!/^\d+$/.test(part)) return null
    const single = Number(part)
    if (single < 1) return null
    if (single > pageCount) continue // silently outside the document
    ranges.push({ from: single, to: single })
  }

  if (ranges.length === 0) return null
  return mergeRanges(ranges)
}

function mergeRanges(ranges: readonly PageRange[]): PageRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from)
  const merged: PageRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to + 1) {
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, range.to) }
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** How many sheets a set of ranges covers, for the "N pages" line. */
export function countPages(ranges: readonly PageRange[], pageCount: number): number {
  if (ranges.length === 0) return pageCount
  return ranges.reduce((total, range) => total + (range.to - range.from + 1), 0)
}

/**
 * Clamps a scale to what Chromium will accept.
 *
 * Outside 10–200 the setting is ignored rather than rejected, so a typo prints
 * at 100% and looks like the control does nothing.
 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 100
  return Math.min(200, Math.max(10, Math.round(scale)))
}

export function clampCopies(copies: number): number {
  if (!Number.isFinite(copies)) return 1
  return Math.min(99, Math.max(1, Math.round(copies)))
}

/** Options for `webContents.print`. */
export function toPrintOptions(
  choices: PrintChoices,
  pageCount: number
): {
  silent: boolean
  printBackground: boolean
  landscape: boolean
  copies: number
  scaleFactor: number
  pageSize: PaperSize
  headerFooter: boolean
  pageRanges?: PageRange[]
} {
  const ranges = parsePageRanges(choices.pageRangeText, pageCount)
  return {
    silent: false,
    printBackground: choices.printBackground,
    landscape: choices.landscape,
    copies: clampCopies(choices.copies),
    scaleFactor: clampScale(choices.scale),
    pageSize: choices.paperSize,
    headerFooter: choices.headerFooter,
    // Omitted entirely rather than sent empty: Chromium reads an empty array as
    // "no pages" and prints nothing at all.
    ...(ranges && ranges.length > 0 ? { pageRanges: ranges } : {})
  }
}

/** Options for `webContents.printToPDF`, used to build the preview. */
export function toPdfOptions(choices: PrintChoices): {
  landscape: boolean
  printBackground: boolean
  scale: number
  pageSize: PaperSize
  displayHeaderFooter: boolean
} {
  return {
    landscape: choices.landscape,
    printBackground: choices.printBackground,
    // printToPDF takes a factor, print takes a percent. Passing 100 here would
    // render the preview at a hundred times actual size — one word per page.
    scale: clampScale(choices.scale) / 100,
    pageSize: choices.paperSize,
    displayHeaderFooter: choices.headerFooter
  }
}
