import { describe, it, expect } from 'vitest'
import { COMPARE_SCRIPT } from './compareScript'

/**
 * The script that runs in the page's own world.
 *
 * Tested because it is a **string**: a syntax error or a typo'd property fails
 * no build, no typecheck and no runtime check anybody sees — the catch turns it
 * into "nothing found" for ever, and a compare feature that quietly finds
 * nothing is indistinguishable from one that is broken. This repository has
 * shipped that exact failure twice elsewhere, which is why the rule exists.
 *
 * Run against stand-ins for the DOM, the same way `extractScript.test.ts` does.
 */
interface FakeElement {
  textContent?: string | null
  tagName?: string
  children?: FakeElement[]
  nextElementSibling?: FakeElement | null
  attributes?: Record<string, string>
}

function element(over: Partial<FakeElement> = {}): FakeElement & {
  getAttribute: (name: string) => string | null
  hasAttribute: (name: string) => boolean
} {
  const attributes = over.attributes ?? {}
  return {
    textContent: null,
    children: [],
    nextElementSibling: null,
    ...over,
    attributes,
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes
  }
}

interface PageShape {
  title?: string
  jsonLd?: unknown[]
  metas?: FakeElement[]
  tableRows?: FakeElement[][]
  definitions?: { term: string; value: string }[]
  headings?: string[]
  bodyText?: string
  description?: string
  siteName?: string
}

function runScript(page: PageShape): Record<string, unknown> | null {
  const metas = (page.metas ?? []).map((meta) => element(meta))

  const jsonLdScripts = (page.jsonLd ?? []).map((data) =>
    element({ textContent: typeof data === 'string' ? data : JSON.stringify(data) })
  )

  const tableRows = (page.tableRows ?? []).map((cells) =>
    element({ children: cells.map((cell) => element(cell)) })
  )

  const terms = (page.definitions ?? []).map((pair) =>
    element({
      textContent: pair.term,
      nextElementSibling: element({ tagName: 'DD', textContent: pair.value })
    })
  )

  const headings = (page.headings ?? []).map((text) => element({ textContent: text }))

  const document = {
    title: page.title ?? '',
    body: { innerText: page.bodyText ?? '' },
    querySelectorAll: (selector: string): unknown[] => {
      if (selector.includes('ld+json')) return jsonLdScripts
      if (selector.includes('meta[')) return metas
      if (selector.includes('table tr')) return tableRows
      if (selector.includes('dl dt')) return terms
      if (selector.includes('h1')) return headings
      return []
    },
    querySelector: (selector: string): unknown => {
      if (selector.includes('name="description"') && page.description !== undefined) {
        return element({ attributes: { content: page.description } })
      }
      if (selector.includes('og:site_name') && page.siteName !== undefined) {
        return element({ attributes: { content: page.siteName } })
      }
      return null
    }
  }

  return new Function('document', `return ${COMPARE_SCRIPT}`)(document) as Record<
    string,
    unknown
  > | null
}

describe('COMPARE_SCRIPT', () => {
  it('parses and runs at all', () => {
    // Guards the test itself. A script that throws on an empty page would fail
    // silently in production, which is the whole reason this file exists.
    const result = runScript({ title: 'A page' })
    expect(result).not.toBeNull()
    expect(result?.title).toBe('A page')
  })

  it('reads JSON-LD properties', () => {
    const result = runScript({
      jsonLd: [{ '@type': 'Product', name: 'Widget', brand: 'Acme' }]
    })
    expect(result?.fields).toMatchObject({ name: 'Widget', brand: 'Acme' })
  })

  it('reads one level into a nested offer', () => {
    // A Product's price lives under its Offer, so stopping at the top level
    // would miss the single most useful field on a shopping page.
    const result = runScript({
      jsonLd: [{ '@type': 'Product', offers: { '@type': 'Offer', price: '999.00' } }]
    })
    expect(result?.fields).toMatchObject({ price: '999.00' })
  })

  it('skips @-prefixed JSON-LD keys', () => {
    const result = runScript({ jsonLd: [{ '@context': 'https://schema.org', name: 'X' }] })
    expect(Object.keys(result?.fields as object)).toEqual(['name'])
  })

  it('survives JSON-LD that is not valid JSON', () => {
    // Real sites ship broken JSON-LD, and one bad block must not cost the rest
    // of the page.
    const result = runScript({
      jsonLd: ['{ not json', { name: 'Survived' }]
    })
    expect(result?.fields).toMatchObject({ name: 'Survived' })
  })

  it('reads a two-column specification table', () => {
    const result = runScript({
      tableRows: [[{ textContent: 'RAM' }, { textContent: '16 GB' }]]
    })
    expect(result?.fields).toMatchObject({ RAM: '16 GB' })
  })

  it('ignores a table row that is not two columns', () => {
    // Three or more columns is a data table, where the first cell is a row
    // label rather than a field name.
    const result = runScript({
      tableRows: [[{ textContent: 'A' }, { textContent: 'B' }, { textContent: 'C' }]]
    })
    expect(result?.fields).toEqual({})
  })

  it('reads a definition list', () => {
    const result = runScript({ definitions: [{ term: 'Weight', value: '1.2 kg' }] })
    expect(result?.fields).toMatchObject({ Weight: '1.2 kg' })
  })

  it('reads product meta tags and drops the namespace', () => {
    const result = runScript({
      metas: [{ attributes: { property: 'product:price:amount', content: '19.99' } }]
    })
    expect(result?.fields).toMatchObject({ 'price amount': '19.99' })
  })

  it('ignores og tags that are about presentation', () => {
    const result = runScript({
      metas: [{ attributes: { property: 'og:image', content: 'https://x.test/a.png' } }]
    })
    expect(result?.fields).toEqual({})
  })

  it('takes the first value when a key appears twice', () => {
    const result = runScript({
      tableRows: [
        [{ textContent: 'Price' }, { textContent: '£999' }],
        [{ textContent: 'Price' }, { textContent: '£1,999' }]
      ]
    })
    expect(result?.fields).toMatchObject({ Price: '£999' })
  })

  it('refuses a row label that is not a field name', () => {
    // Wikipedia's browser timeline is a two-column table, so every year became
    // a "field" and the comparison filled with rows like "2001 | Not detected |
    // iCab 2.5 Internet Explorer 6 …". Found by running it, not by reading it.
    const result = runScript({
      tableRows: [
        [{ textContent: '2001' }, { textContent: 'iCab 2.5 Internet Explorer 6' }],
        [{ textContent: 'RAM' }, { textContent: '16 GB' }]
      ]
    })
    expect(result?.fields).toEqual({ RAM: '16 GB' })
  })

  it('refuses a key long enough to be a sentence', () => {
    const result = runScript({
      tableRows: [[{ textContent: 'w'.repeat(60) }, { textContent: 'x' }]]
    })
    expect(result?.fields).toEqual({})
  })

  it('drops a value long enough to be prose', () => {
    const result = runScript({
      tableRows: [[{ textContent: 'Notes' }, { textContent: 'x'.repeat(500) }]]
    })
    expect(result?.fields).toEqual({})
  })

  it('bounds how many fields it returns', () => {
    // An unbounded read on a page with a thousand-row table is a payload nobody
    // asked for crossing the IPC boundary.
    const rows = Array.from({ length: 300 }, (_, i) => [
      { textContent: `Field ${i}` },
      { textContent: `Value ${i}` }
    ])
    const result = runScript({ tableRows: rows })
    expect(Object.keys(result?.fields as object).length).toBeLessThanOrEqual(60)
  })

  it('collects headings and stops at a sane number', () => {
    const result = runScript({
      headings: Array.from({ length: 40 }, (_, i) => `Heading ${i}`)
    })
    expect((result?.headings as string[]).length).toBeLessThanOrEqual(12)
  })

  it('skips an empty heading', () => {
    const result = runScript({ headings: ['', '   ', 'Real'] })
    expect(result?.headings).toEqual(['Real'])
  })

  it('reads the description and site name', () => {
    const result = runScript({ description: 'About this', siteName: 'Example Shop' })
    expect(result?.description).toBe('About this')
    expect(result?.siteName).toBe('Example Shop')
  })

  it('reports null for a description that is not there', () => {
    expect(runScript({})?.description).toBeNull()
  })

  it('counts words rather than estimating them', () => {
    const result = runScript({ bodyText: 'one two   three\nfour' })
    expect(result?.wordCount).toBe(4)
  })

  it('returns null rather than throwing on a hostile document', () => {
    const broken = {
      get title(): string {
        throw new Error('no')
      }
    }
    expect(new Function('document', `return ${COMPARE_SCRIPT}`)(broken)).toBeNull()
  })
})
