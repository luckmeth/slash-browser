import { describe, it, expect } from 'vitest'
import { countPdfPages } from './pdfPageCount'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('countPdfPages', () => {
  it('reads the page-tree root count', () => {
    expect(countPdfPages(bytes('%PDF-1.7\n2 0 obj\n<< /Type /Pages /Count 12 /Kids [] >>\n'))).toBe(12)
  })

  it('reads it with the keys the other way round', () => {
    // Both orders appear in real output; a dictionary has no defined key order.
    expect(countPdfPages(bytes('<< /Count 7 /Type /Pages >>'))).toBe(7)
  })

  it('takes the largest when the tree has nested nodes', () => {
    // Nested page-tree nodes carry their own subtotals; the root carries the
    // document total.
    const pdf = '<< /Type /Pages /Count 3 >> << /Type /Pages /Count 9 >>'
    expect(countPdfPages(bytes(pdf))).toBe(9)
  })

  it('tolerates the count living at the very end of the file', () => {
    const pdf = '%PDF-1.7\n' + 'x'.repeat(200_000) + '\n<< /Type /Pages /Count 4 >>\n%%EOF'
    expect(countPdfPages(bytes(pdf))).toBe(4)
  })

  it('returns null rather than guessing when it cannot tell', () => {
    // A wrong count would clamp a legitimate page range down to nothing, and
    // the wrong pages would come out of the printer with nothing explaining it.
    expect(countPdfPages(bytes('%PDF-1.7\nnothing useful here\n%%EOF'))).toBeNull()
    expect(countPdfPages(new Uint8Array(0))).toBeNull()
  })

  it('ignores a zero or negative count', () => {
    expect(countPdfPages(bytes('<< /Type /Pages /Count 0 >>'))).toBeNull()
  })

  it('is not confused by high bytes beside the dictionary', () => {
    // Decoding as utf-8 replaces stray high bytes with U+FFFD, which can eat the
    // characters either side of a /Count.
    const raw = new Uint8Array([
      ...bytes('<< /Type /Pages /Count 5 >>'),
      0xff,
      0xfe,
      0x81
    ])
    expect(countPdfPages(raw)).toBe(5)
  })
})
