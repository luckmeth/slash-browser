/**
 * How many pages a generated PDF has.
 *
 * Needed only to say "3 of 12" beside the page-range box and to clamp a range to
 * the document. Deliberately returns **null** rather than a guess when it cannot
 * tell: a wrong count would clamp a legitimate range down to nothing, and the
 * user would watch the wrong pages come out of the printer with no clue why.
 *
 * Reads the `/Count` on the page-tree root rather than tallying `/Type /Page`
 * objects. Chromium packs page objects into compressed object streams, where the
 * individual `/Type /Page` markers are not visible in the raw bytes at all — but
 * the trailer and the catalogue usually are.
 */
export function countPdfPages(pdf: Uint8Array): number | null {
  // Only the head and tail are searched. A large PDF is mostly compressed image
  // data, and scanning all of it as text to find a number near the front is
  // pure cost.
  const head = decode(pdf.subarray(0, Math.min(pdf.length, 64_000)))
  const tail = decode(pdf.subarray(Math.max(0, pdf.length - 64_000)))

  const counts: number[] = []
  for (const chunk of [head, tail]) {
    // `/Type /Pages` and `/Count N` can appear in either order inside the same
    // dictionary, so both directions are tried.
    const pattern = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(chunk)) !== null) {
      const value = Number(match[1] ?? match[2])
      if (Number.isInteger(value) && value > 0) counts.push(value)
    }
  }

  if (counts.length === 0) return null
  // The root of the page tree carries the total; nested nodes carry their own
  // subtotals, so the largest is the document.
  return Math.max(...counts)
}

function decode(bytes: Uint8Array): string {
  // latin1 rather than utf-8: PDF syntax is byte-oriented, and utf-8 decoding
  // replaces stray high bytes with U+FFFD, which can swallow a `/Count` that
  // happens to sit next to binary data.
  return new TextDecoder('latin1').decode(bytes)
}
