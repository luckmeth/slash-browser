import { describe, expect, it } from 'vitest'
import {
  CRAWL_LIMITS,
  clampOptions,
  DEFAULT_CRAWL,
  decodeHtmlUrl,
  extensionOfUrl,
  extractLinks,
  linkLabel,
  isPageLike,
  matchesFilter,
  parseRobots,
  robotsAllows,
  sameOrigin,
  shouldVisit,
  type RobotsRules
} from './crawlPlan'

const SEED = 'https://files.example.test/docs/index.html'

describe('clampOptions — a caller cannot ask for more than is allowed', () => {
  it('caps depth and page count', () => {
    // The bounds are the whole reason this is safe to ship in a browser: an
    // unbounded crawl of a forum is indistinguishable from an attack, and the
    // person who pressed the button did not intend one.
    const clamped = clampOptions({ depth: 99, maxPages: 100_000 })
    expect(clamped.depth).toBe(CRAWL_LIMITS.maxDepth)
    expect(clamped.maxPages).toBe(CRAWL_LIMITS.maxPages)
  })

  it('refuses a negative or zero request rather than looping forever', () => {
    expect(clampOptions({ depth: -5 }).depth).toBe(0)
    expect(clampOptions({ maxPages: 0 }).maxPages).toBe(1)
  })

  it('respects robots by default', () => {
    expect(DEFAULT_CRAWL.respectRobots).toBe(true)
    expect(clampOptions({}).respectRobots).toBe(true)
  })

  it('normalises extension filters people actually type', () => {
    expect(clampOptions({ extensions: ['.PDF', '*.mp4', ' zip '] }).extensions).toEqual([
      'pdf',
      'mp4',
      'zip'
    ])
  })
})

describe('extractLinks', () => {
  it('finds anchors and resolves them against the page', () => {
    const html = `<a href="a.pdf">A</a><a href='/b.pdf'>B</a><a href=c.pdf>C</a>`
    expect(extractLinks(html, SEED).map((link) => link.url)).toEqual([
      'https://files.example.test/docs/a.pdf',
      'https://files.example.test/b.pdf',
      'https://files.example.test/docs/c.pdf'
    ])
  })

  it('decodes &amp; in query strings, which is the one that breaks addresses', () => {
    // `?a=1&amp;b=2` fetched literally is a different URL and 404s.
    const links = extractLinks('<a href="get?a=1&amp;b=2">x</a>', SEED)
    expect(links[0]?.url).toBe('https://files.example.test/docs/get?a=1&b=2')
  })

  it('drops fragments, which name a place on a page rather than a page', () => {
    expect(extractLinks('<a href="page.html#section">x</a>', SEED).map((l) => l.url)).toEqual([
      'https://files.example.test/docs/page.html'
    ])
  })

  it.each(['#top', 'javascript:void(0)', 'mailto:a@b.test', 'tel:123', 'data:text/plain,x'])(
    'ignores %s',
    (href) => {
      expect(extractLinks(`<a href="${href}">x</a>`, SEED)).toEqual([])
    }
  )

  it('survives malformed markup instead of throwing', () => {
    expect(() => extractLinks('<a href=="x"><a href>', SEED)).not.toThrow()
  })

  it('stops at the per-page link cap', () => {
    // A sitemap page must not be able to blow up the queue on its own.
    const html = '<a href="a.html">x</a>'.repeat(CRAWL_LIMITS.maxLinksPerPage + 50)
    expect(extractLinks(html, SEED).length).toBe(CRAWL_LIMITS.maxLinksPerPage)
  })

  it('resolves a nonsense href as a relative path rather than escaping the origin', () => {
    // `ht!tp://[[[` is not a scheme — it is an odd relative path, and resolving
    // it that way is correct. What matters is that it cannot leave the seed's
    // origin, because that is the boundary the whole crawl relies on. It will
    // 404 and be dropped, which costs one request and no correctness.
    const links = extractLinks('<a href="ht!tp://[[[">x</a>', SEED)
    for (const link of links) {
      expect(new URL(link.url).origin).toBe(new URL(SEED).origin)
    }
  })
})

describe('link labels — what makes the deceptive-link check work', () => {
  it('carries the anchor text alongside the address', () => {
    // `analyseLink`'s strongest signal is "says Download, goes elsewhere".
    // Without the text that check silently never fires.
    const links = extractLinks('<a href="/x.exe">Download the manual (PDF)</a>', SEED)
    expect(links[0]?.label).toBe('Download the manual (PDF)')
  })

  it('strips nested markup down to the words', () => {
    const links = extractLinks('<a href="/x.zip"><span><b>Get</b> it</span></a>', SEED)
    expect(links[0]?.label).toBe('Get it')
  })

  it('falls back to an image alt when the link is a button', () => {
    // An image button reading "Download" is a common shape for the exact
    // deception being looked for, and it has no text at all.
    const links = extractLinks('<a href="/x.exe"><img src="b.png" alt="Download now"></a>', SEED)
    expect(links[0]?.label).toBe('Download now')
  })

  it('is empty rather than wrong when there is nothing to read', () => {
    expect(linkLabel('<img src="b.png">')).toBe('')
  })

  it('decodes entities in the text as well as the address', () => {
    expect(linkLabel('Tom &amp; Jerry')).toBe('Tom & Jerry')
  })

  it('still yields the address when the anchor is never closed', () => {
    // The address matters more than the label; a malformed anchor must not
    // cost us the file it points at.
    const links = extractLinks('<a href="/x.pdf">unclosed', SEED)
    expect(links[0]?.url).toBe('https://files.example.test/x.pdf')
  })
})

describe('decodeHtmlUrl', () => {
  it('handles the named entities that appear in addresses', () => {
    expect(decodeHtmlUrl('a&amp;b&quot;c')).toBe('a&b"c')
  })

  it('handles numeric references', () => {
    expect(decodeHtmlUrl('a&#38;b&#x26;c')).toBe('a&b&c')
  })

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(decodeHtmlUrl('a&nbsp;b')).toBe('a&nbsp;b')
  })
})

describe('sameOrigin — not a setting', () => {
  it('accepts the same origin', () => {
    expect(sameOrigin('https://files.example.test/x/y.pdf', SEED)).toBe(true)
  })

  it('refuses a different host, a subdomain and a scheme change', () => {
    // Following off-site links would turn "grab this site" into "crawl the web
    // from here", with the user's own address and cookies.
    expect(sameOrigin('https://other.test/y.pdf', SEED)).toBe(false)
    expect(sameOrigin('https://cdn.files.example.test/y.pdf', SEED)).toBe(false)
    expect(sameOrigin('http://files.example.test/y.pdf', SEED)).toBe(false)
  })
})

describe('extensionOfUrl and filters', () => {
  it('reads the extension past a query string', () => {
    expect(extensionOfUrl('https://a.test/report.pdf?v=2')).toBe('pdf')
  })

  it('returns empty for a directory-style address', () => {
    expect(extensionOfUrl('https://a.test/docs/')).toBe('')
    expect(extensionOfUrl('https://a.test/docs')).toBe('')
  })

  it('is not fooled by a dot in a path segment', () => {
    expect(extensionOfUrl('https://a.test/v1.2/page')).toBe('')
  })

  it('collects everything when no filter is set', () => {
    expect(matchesFilter('https://a.test/x.exe', [])).toBe(true)
  })

  it('collects only what was asked for when one is', () => {
    expect(matchesFilter('https://a.test/x.pdf', ['pdf', 'zip'])).toBe(true)
    expect(matchesFilter('https://a.test/x.exe', ['pdf', 'zip'])).toBe(false)
  })
})

describe('parseRobots', () => {
  it('reads only the group that applies to us', () => {
    // Slash does not announce itself as a named crawler, so reading a named
    // group's more permissive rules would be claiming to be something else.
    const rules = parseRobots(`
      User-agent: Googlebot
      Disallow: /

      User-agent: *
      Disallow: /private/
      Allow: /private/public/
    `)
    expect(rules.disallow).toEqual(['/private/'])
    expect(rules.allow).toEqual(['/private/public/'])
  })

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# hello\nUser-agent: *\n\nDisallow: /x/ # trailing\n')
    expect(rules.disallow).toEqual(['/x/'])
  })

  it('treats an empty Disallow as no restriction, not as everything', () => {
    // `Disallow:` with no value means "nothing is disallowed". Storing it as an
    // empty prefix would match every path and block the whole site.
    expect(parseRobots('User-agent: *\nDisallow:').disallow).toEqual([])
  })

  it('returns nothing restrictive for a missing or malformed file', () => {
    expect(parseRobots('').disallow).toEqual([])
    expect(parseRobots('<!DOCTYPE html><html>404</html>').disallow).toEqual([])
  })
})

describe('robotsAllows', () => {
  const rules: RobotsRules = { disallow: ['/private/'], allow: ['/private/public/'] }

  it('allows an unlisted path', () => {
    expect(robotsAllows('https://a.test/docs/x.pdf', rules)).toBe(true)
  })

  it('refuses a disallowed prefix', () => {
    expect(robotsAllows('https://a.test/private/x.pdf', rules)).toBe(false)
  })

  it('lets a longer Allow win, which is what its author expects', () => {
    expect(robotsAllows('https://a.test/private/public/x.pdf', rules)).toBe(true)
  })

  it('allows everything when the site said nothing', () => {
    expect(robotsAllows('https://a.test/anything', { disallow: [], allow: [] })).toBe(true)
  })

  it('refuses an address it cannot parse rather than assuming permission', () => {
    expect(robotsAllows('not a url', rules)).toBe(false)
  })
})

describe('shouldVisit — the frontier', () => {
  const options = clampOptions({ depth: 2, respectRobots: true })
  const noRules: RobotsRules = { disallow: [], allow: [] }

  it('follows a same-origin page within depth', () => {
    expect(shouldVisit(`${new URL(SEED).origin}/docs/next.html`, SEED, 1, new Set(), options, noRules)).toBe(
      true
    )
  })

  it('stops at the depth it was given', () => {
    expect(shouldVisit(`${new URL(SEED).origin}/deep.html`, SEED, 3, new Set(), options, noRules)).toBe(
      false
    )
  })

  it('never visits the same page twice', () => {
    const url = `${new URL(SEED).origin}/a.html`
    expect(shouldVisit(url, SEED, 1, new Set([url]), options, noRules)).toBe(false)
  })

  it('never leaves the origin', () => {
    expect(shouldVisit('https://other.test/a.html', SEED, 1, new Set(), options, noRules)).toBe(false)
  })

  it('honours robots when asked to', () => {
    const rules: RobotsRules = { disallow: ['/docs/'], allow: [] }
    expect(shouldVisit(`${new URL(SEED).origin}/docs/a.html`, SEED, 1, new Set(), options, rules)).toBe(
      false
    )
  })

  it('does not crawl into a file — that is something to collect, not read', () => {
    expect(shouldVisit(`${new URL(SEED).origin}/big.zip`, SEED, 1, new Set(), options, noRules)).toBe(
      false
    )
  })
})

describe('isPageLike', () => {
  it.each(['https://a.test/x', 'https://a.test/x/', 'https://a.test/x.html', 'https://a.test/x.php'])(
    'treats %s as a page',
    (url) => {
      expect(isPageLike(url)).toBe(true)
    }
  )

  it.each(['https://a.test/x.pdf', 'https://a.test/x.zip', 'https://a.test/x.mp4'])(
    'treats %s as a file',
    (url) => {
      expect(isPageLike(url)).toBe(false)
    }
  )
})
