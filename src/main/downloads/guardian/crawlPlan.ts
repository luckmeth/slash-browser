/**
 * Deciding what a site grab is allowed to visit.
 *
 * The Download Guardian already reads the page you are on and offers every file
 * it links to. A **site grab** is that, one step further: follow the links on
 * this page, and the links on those, and collect the files. It is the feature
 * people install a download manager for when a site publishes a hundred PDFs
 * across twenty pages.
 *
 * It is also a crawler, and a crawler in a browser is a thing to be careful
 * with. Everything here exists to keep one honest:
 *
 *  - **Same origin, always.** Following off-site links would turn "grab this
 *    site" into "crawl the web from here", and the request would come from the
 *    user's own address with their own cookies. Not an option, not a setting.
 *  - **Bounded before it starts.** Depth, page count and total links are capped,
 *    and the caps are stated. An unbounded crawl of a forum is indistinguishable
 *    from an attack, and the person running it did not intend one.
 *  - **`robots.txt` is respected.** IDM's grabber does not. But IDM is a
 *    separate application a user pointed at a site; this is a browser making
 *    requests as that user, and a browser that ignores a site's stated wishes
 *    while wearing their cookies is a different and worse thing.
 *
 * Pure, so every one of those limits is a test rather than a hope.
 */

/** Ceilings. Deliberately modest — a grab is a convenience, not a mirror. */
export const CRAWL_LIMITS = {
  /** Links deep from the starting page. 2 covers "index → section → files". */
  maxDepth: 3,
  /** Pages fetched in one grab, whatever the depth allows. */
  maxPages: 200,
  /** Links read from any one page, so a sitemap cannot blow the queue up. */
  maxLinksPerPage: 500,
  /** Bytes of HTML read per page before giving up on it. */
  maxPageBytes: 4 * 1024 * 1024,
  /** Files collected before the grab stops offering more. */
  maxFiles: 1000
} as const

export interface CrawlOptions {
  /** How many links deep to follow. Clamped to `CRAWL_LIMITS.maxDepth`. */
  readonly depth: number
  /** Pages to fetch at most. Clamped to `CRAWL_LIMITS.maxPages`. */
  readonly maxPages: number
  /**
   * Extensions to collect, lowercase and without dots. Empty means every file
   * the guardian recognises.
   */
  readonly extensions: readonly string[]
  /** Whether to honour the site's `robots.txt`. Default true, and it should be. */
  readonly respectRobots: boolean
}

export const DEFAULT_CRAWL: CrawlOptions = {
  depth: 1,
  maxPages: 50,
  extensions: [],
  respectRobots: true
}

/** Applies the ceilings, so a caller cannot ask for more than is allowed. */
export function clampOptions(options: Partial<CrawlOptions>): CrawlOptions {
  const depth = Math.max(0, Math.min(options.depth ?? DEFAULT_CRAWL.depth, CRAWL_LIMITS.maxDepth))
  const maxPages = Math.max(
    1,
    Math.min(options.maxPages ?? DEFAULT_CRAWL.maxPages, CRAWL_LIMITS.maxPages)
  )
  return {
    depth,
    maxPages,
    extensions: (options.extensions ?? []).map((value) =>
      value.trim().toLowerCase().replace(/^[.*]+/, '')
    ).filter((value) => value !== ''),
    respectRobots: options.respectRobots ?? true
  }
}

/**
 * The `&amp;` problem.
 *
 * An `href` in HTML source is entity-encoded, and `&amp;` inside a query string
 * is overwhelmingly the one that matters — `?a=1&amp;b=2` fetched literally is a
 * different URL from the one the link points at, and the request 404s. The other
 * named entities practically never appear in an address; numeric ones are
 * handled because they cost one line.
 */
export function decodeHtmlUrl(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_whole, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
}

/** A link, with the words the page put on it. */
export interface ExtractedLink {
  readonly url: string
  /**
   * The anchor's visible text, collapsed.
   *
   * Carried because `analyseLink`'s strongest signal is a mismatch between what
   * a link *says* and where it *goes* — that mismatch is the actual mechanic of
   * a deceptive download button. Extracting links without their text would hand
   * the guardian a blank label for every one and silently disable the check
   * across a whole grab, which is exactly where nobody would notice.
   */
  readonly label: string
}

/**
 * Every link on a page, absolute, with its text.
 *
 * A regex rather than a parser, and that is a deliberate trade: this reads
 * anchors out of arbitrary HTML from the open web, where a real parser would
 * spend most of its effort on malformed markup that changes nothing about which
 * `href`s are present. A link this misses is a file not offered, which is a
 * small loss; there is no failure mode where it invents one, because every
 * result must still resolve against the page's own address.
 */
export function extractLinks(html: string, pageUrl: string): ExtractedLink[] {
  const found: ExtractedLink[] = []
  // The closing tag is optional in the match, so a malformed anchor still
  // yields its href — the address matters more than the label.
  const pattern =
    /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]{0,400}?)(?:<\/a>|$)/gi

  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    if (found.length >= CRAWL_LIMITS.maxLinksPerPage) break
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (raw === '') continue
    // Fragments and non-navigable schemes are not pages and not files.
    if (/^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(raw)) continue

    try {
      const resolved = new URL(decodeHtmlUrl(raw), pageUrl)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      // The fragment identifies a place on a page, not a different page.
      resolved.hash = ''
      found.push({ url: resolved.toString(), label: linkLabel(match[4] ?? '') })
    } catch {
      // A link that will not resolve is not one we can follow.
    }
  }
  return found
}

/** Inner markup to the words a person would actually read. */
export function linkLabel(inner: string): string {
  // An image-only link has no words; its `alt` is the nearest thing to them,
  // and an image button saying "Download" is a common shape for exactly the
  // deception `analyseLink` is looking for.
  const alt = /<img\b[^>]*?\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(inner)
  const words = decodeHtmlUrl(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
  if (words !== '') return words.slice(0, 200)
  return decodeHtmlUrl(alt?.[1] ?? alt?.[2] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Same site, by exact host. A subdomain is a different server's decision. */
export function sameOrigin(candidate: string, seed: string): boolean {
  try {
    return new URL(candidate).origin === new URL(seed).origin
  } catch {
    return false
  }
}

/** `…/report.pdf?v=2` → `pdf`. Empty when the address names no file type. */
export function extensionOfUrl(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase()
    const last = path.split('/').pop() ?? ''
    const dot = last.lastIndexOf('.')
    if (dot <= 0) return ''
    const extension = last.slice(dot + 1)
    return /^[a-z0-9]{1,8}$/.test(extension) ? extension : ''
  } catch {
    return ''
  }
}

/** Whether this address is one the grab was asked to collect. */
export function matchesFilter(url: string, extensions: readonly string[]): boolean {
  if (extensions.length === 0) return true
  return extensions.includes(extensionOfUrl(url))
}

// --- robots.txt --------------------------------------------------------------

export interface RobotsRules {
  /** Path prefixes the site asked crawlers not to fetch. */
  readonly disallow: string[]
  /** Prefixes explicitly re-allowed, which win over a longer Disallow. */
  readonly allow: string[]
}

export const ROBOTS_ALLOW_ALL: RobotsRules = { disallow: [], allow: [] }

/**
 * Reads the rules that apply to us.
 *
 * Only the `*` group is read. Slash does not announce itself as a named crawler,
 * so claiming a more permissive group would be claiming to be something else.
 * A malformed or missing file means no restrictions — which is what a missing
 * `robots.txt` means everywhere.
 */
export function parseRobots(text: string): RobotsRules {
  const disallow: string[] = []
  const allow: string[] = []
  let inStarGroup = false

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.split('#')[0]?.trim() ?? ''
    if (stripped === '') continue

    const colon = stripped.indexOf(':')
    if (colon === -1) continue
    const field = stripped.slice(0, colon).trim().toLowerCase()
    const value = stripped.slice(colon + 1).trim()

    if (field === 'user-agent') {
      inStarGroup = value === '*'
      continue
    }
    if (!inStarGroup) continue
    // An empty Disallow means "nothing is disallowed" and must not become a
    // prefix that matches every path.
    if (field === 'disallow' && value !== '') disallow.push(value)
    if (field === 'allow' && value !== '') allow.push(value)
  }

  return { disallow, allow }
}

/**
 * Whether the site is willing for this path to be fetched.
 *
 * Longest match wins, and `Allow` beats `Disallow` at equal length — the
 * behaviour every major crawler implements, and the reason `/private/` plus
 * `Allow: /private/public/` does what its author expects.
 */
export function robotsAllows(url: string, rules: RobotsRules): boolean {
  let path: string
  try {
    const parsed = new URL(url)
    path = `${parsed.pathname}${parsed.search}`
  } catch {
    return false
  }

  const longest = (prefixes: readonly string[]): number =>
    prefixes.reduce((best, prefix) => (path.startsWith(prefix) ? Math.max(best, prefix.length) : best), -1)

  const denied = longest(rules.disallow)
  if (denied === -1) return true
  return longest(rules.allow) >= denied
}

// --- the frontier ------------------------------------------------------------

export interface CrawlStep {
  readonly url: string
  readonly depth: number
}

/**
 * Whether this link should join the queue.
 *
 * Every rule that stops a grab running away lives here, in one place, so the
 * reason a page was skipped can be stated rather than guessed at.
 */
export function shouldVisit(
  candidate: string,
  seed: string,
  depth: number,
  seen: ReadonlySet<string>,
  options: CrawlOptions,
  robots: RobotsRules
): boolean {
  if (depth > options.depth) return false
  if (seen.has(candidate)) return false
  if (!sameOrigin(candidate, seed)) return false
  if (options.respectRobots && !robotsAllows(candidate, robots)) return false
  // A link that names a file is a thing to collect, not a page to read.
  return extensionOfUrl(candidate) === '' || isPageLike(candidate)
}

/** Extensions that are documents to read rather than files to download. */
const PAGE_EXTENSIONS = new Set(['htm', 'html', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'xhtml'])

export function isPageLike(url: string): boolean {
  const extension = extensionOfUrl(url)
  return extension === '' || PAGE_EXTENSIONS.has(extension)
}
