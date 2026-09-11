/**
 * Which of a page's declared icons to keep.
 *
 * Chromium hands over every icon a page declared, and the browser took
 * `favicons[0]` — which is almost always the 16×16 `/favicon.ico`, because that
 * is what sites list first for historical reasons. Every surface then draws it
 * in a 16 CSS-pixel box, so at 125% display scaling that bitmap is stretched to
 * 20 device pixels and at 200% to 32. Favicons are the most repeated image in
 * the product — the tab strip, the omnibox, history, the reading list, tab
 * search — so they are also the most visible pixelation in it.
 *
 * **This never makes a request.** It ranks the strings the page itself
 * declared and picks one. A favicon *service* would sharpen these too, and
 * would also send one hostname at a time to a third party for every site
 * somebody visits — which is precisely the thing this browser is sold as not
 * doing. Principle 2 is satisfied here by construction rather than by policy:
 * there is nothing in this file that could reach the network.
 *
 * The honest limit: a URL is not a guarantee. `icon-192.png` might be 32 pixels
 * and a mislabelled `.svg` might be a bitmap. Ranking by the evidence available
 * without fetching is still strictly better than taking the first entry, and
 * the floor is exactly today's behaviour.
 */

/** Sizes hinted in an icon's address: `favicon-32x32.png`, `icon-180.png`. */
export function hintedSize(url: string): number {
  // `180x180` or `32x32` — the common form, and the pair must match so a
  // hash like `a1b2` cannot be read as a size.
  const square = /(\d{2,4})x(\d{2,4})/i.exec(url)
  if (square && square[1] === square[2]) return Number(square[1])

  // `apple-touch-icon-180.png`, `icon-192.png`. Anchored to a separator so a
  // version or a cache-buster is not mistaken for a dimension.
  const trailing = /[-_](\d{2,4})\.(?:png|jpe?g|webp|ico)(?:$|[?#])/i.exec(url)
  if (trailing) return Number(trailing[1])

  return 0
}

/**
 * Higher is better. Ordered so the reasons are readable rather than numeric
 * accidents.
 */
function score(url: string): number {
  const lower = url.toLowerCase()

  // Already inlined by whoever sent it: no second request, and it is whatever
  // the page chose to embed.
  if (lower.startsWith('data:')) return 1000

  // Resolution independent, which is the whole problem solved.
  if (/\.svg(?:$|[?#])/.test(lower)) return 900

  const hinted = hintedSize(lower)
  // A hinted size is the best evidence available without fetching. Capped well
  // above any sensible icon so it cannot outrank an SVG.
  if (hinted > 0) return Math.min(hinted, 512)

  // Conventionally 120px or larger, and named for a platform rather than a size.
  if (lower.includes('apple-touch-icon')) return 180

  // The 16×16 default. Ranked last of the real candidates rather than excluded,
  // because on most sites it is the only thing offered.
  if (/\/favicon\.ico(?:$|[?#])/.test(lower)) return 1

  // An icon with no clues: still better than the legacy default.
  return 10
}

/**
 * The best icon from what a page declared, or null when it declared nothing.
 *
 * Stable for equal scores — the first of an equal pair wins, which keeps the
 * page's own ordering as the tie-break rather than introducing one.
 */
export function pickFavicon(candidates: readonly string[]): string | null {
  let best: string | null = null
  let bestScore = -1

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const value = score(candidate)
    if (value > bestScore) {
      best = candidate
      bestScore = value
    }
  }

  return best
}
