/**
 * Comparing tabs, without inventing anything.
 *
 * The temptation in a compare feature is to fill the gaps: page A lists a price
 * and page B does not, so the table gets a plausible number from somewhere. This
 * refuses to. A cell is either a value the page actually stated or the words
 * **Not detected**, and the spec this was built to says exactly why that is the
 * better answer — a comparison somebody trusts and which is wrong once is worse
 * than one that admits what it could not find.
 *
 * Entirely local and entirely deterministic. No model is consulted, so there is
 * nothing here that could hallucinate a specification; the cost is that it finds
 * only what a page has put in a place worth looking — structured data, a
 * specification table, a meta tag — and the UI says so rather than implying the
 * absence means anything about the product.
 */

/** What one page offered up. Produced by the page-world script. */
export interface PageFacts {
  readonly tabId: string
  readonly url: string
  readonly title: string
  /** From `<meta name="description">` or Open Graph. */
  readonly description: string | null
  readonly siteName: string | null
  /**
   * Key/value pairs the page stated about itself.
   *
   * JSON-LD properties and two-column specification tables, merged. Keys are as
   * the page wrote them; `alignFacts` is what decides two differently-spelled
   * keys are the same field.
   *
   * The member types are mutable deliberately: these values cross IPC, where
   * they are plain JSON, and a `readonly string[]` is not assignable to the
   * `string[]` the contract infers. Marking them readonly would buy nothing and
   * cost a cast at the boundary, which is where a cast does the most harm.
   */
  readonly fields: Record<string, string>
  readonly headings: string[]
  readonly wordCount: number
}

export interface ComparisonCell {
  readonly tabId: string
  /** Null means the page did not state this. Never a guess. */
  readonly value: string | null
}

export interface ComparisonRow {
  readonly field: string
  readonly cells: readonly ComparisonCell[]
  /** True when every page stated it and they do not all agree. */
  readonly differs: boolean
  /** How many pages stated it at all. */
  readonly stated: number
}

export interface Comparison {
  readonly pages: readonly PageFacts[]
  /** Rows where at least one page said something, most-covered first. */
  readonly rows: readonly ComparisonRow[]
  /** True when no page offered a single structured field. */
  readonly empty: boolean
}

/**
 * Field names that mean the same thing written different ways.
 *
 * A named list, deliberately short. Guessing that two keys match because they
 * share a word would put a laptop's "screen size" next to a book's "size" and
 * present it as a comparison; being wrong here is worse than showing two rows.
 */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  price: 'Price',
  cost: 'Price',
  'list price': 'Price',
  offers: 'Price',
  ram: 'RAM',
  memory: 'RAM',
  'system memory': 'RAM',
  storage: 'Storage',
  'hard drive': 'Storage',
  ssd: 'Storage',
  cpu: 'Processor',
  processor: 'Processor',
  chip: 'Processor',
  gpu: 'Graphics',
  graphics: 'Graphics',
  display: 'Display',
  screen: 'Display',
  'screen size': 'Display',
  battery: 'Battery',
  weight: 'Weight',
  brand: 'Brand',
  manufacturer: 'Brand',
  model: 'Model',
  sku: 'Model',
  rating: 'Rating',
  ratingvalue: 'Rating',
  'aggregate rating': 'Rating',
  author: 'Author',
  datepublished: 'Published',
  'date published': 'Published',
  published: 'Published',
  availability: 'Availability',
  'in stock': 'Availability'
}

/** The normalised name for a field, or the page's own if it is not known. */
export function canonicalField(key: string): string {
  const trimmed = key.trim().replace(/[:：]\s*$/, '')
  const lower = trimmed.toLowerCase()
  const alias = FIELD_ALIASES[lower]
  if (alias) return alias
  // Title-case the page's own wording rather than shouting it back.
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/**
 * Rows worth showing first.
 *
 * A field every page stated is more useful than one only one page did, and
 * within that the well-known fields lead — somebody comparing two laptops wants
 * price and memory above "Shipping information".
 */
const PRIORITY = [
  'Price',
  'Rating',
  'Availability',
  'Processor',
  'Graphics',
  'RAM',
  'Storage',
  'Display',
  'Battery',
  'Weight',
  'Brand',
  'Model',
  'Author',
  'Published'
]

/** Below this a "field" is a paragraph that happened to sit in a table cell. */
const MAX_VALUE_LENGTH = 120

export function alignFacts(pages: readonly PageFacts[]): Comparison {
  const byField = new Map<string, Map<string, string>>()

  for (const page of pages) {
    for (const [rawKey, rawValue] of Object.entries(page.fields)) {
      const value = rawValue.trim().replace(/\s+/g, ' ')
      if (value === '' || value.length > MAX_VALUE_LENGTH) continue

      const field = canonicalField(rawKey)
      if (field === '') continue

      const row = byField.get(field) ?? new Map<string, string>()
      // First statement wins: a page listing a field twice is stating it once
      // as far as a comparison is concerned, and the later copy is usually a
      // footer repeating the header.
      if (!row.has(page.tabId)) row.set(page.tabId, value)
      byField.set(field, row)
    }
  }

  const rows: ComparisonRow[] = []
  for (const [field, values] of byField) {
    const cells = pages.map((page) => ({
      tabId: page.tabId,
      value: values.get(page.tabId) ?? null
    }))
    const stated = cells.filter((cell) => cell.value !== null).length
    const distinct = new Set(cells.map((cell) => cell.value).filter((v) => v !== null))
    rows.push({
      field,
      cells,
      // Only meaningful when everybody answered. Two pages where one is silent
      // do not "differ" — one of them simply did not say.
      differs: stated === pages.length && distinct.size > 1,
      stated
    })
  }

  rows.sort((a, b) => {
    if (a.stated !== b.stated) return b.stated - a.stated
    const ap = PRIORITY.indexOf(a.field)
    const bp = PRIORITY.indexOf(b.field)
    if (ap !== bp) return (ap === -1 ? 999 : ap) - (bp === -1 ? 999 : bp)
    return a.field.localeCompare(b.field)
  })

  return { pages, rows, empty: rows.length === 0 }
}

/**
 * The sentence shown when nothing structured was found.
 *
 * Says what was looked for and what that absence means, because "no comparison
 * available" reads as a broken feature when the truthful reading is that these
 * pages do not publish machine-readable facts about themselves.
 */
export const NO_FIELDS_NOTE =
  'Neither page published structured details — no product data, article metadata or ' +
  'specification table. Slash compares what a page states about itself and does not ' +
  'guess at the rest, so what follows is the pages side by side instead.'

/** How many tabs a comparison may hold. */
export const MAX_COMPARE_TABS = 4
export const MIN_COMPARE_TABS = 2
