/**
 * Domain-based request blocking, the network half of Slash Shield.
 *
 * Matching is by hostname, walking up the domain tree: a rule for
 * `doubleclick.net` blocks `stats.g.doubleclick.net` too. That is the same shape
 * as a DNS-level blocker, and it catches the large majority of advertising and
 * tracking traffic for a fraction of the complexity of a full filter-syntax
 * engine.
 *
 * **What this deliberately does not do:** cosmetic filtering (hiding the empty
 * boxes ads leave behind), regex URL patterns, or per-element rules. uBlock
 * Origin does those; this does not, and the UI does not claim otherwise.
 *
 * Pure and free of Electron imports so the matching rules are unit-testable.
 */

/**
 * Why a host is on a list.
 *
 * Split because the dashboard reports ads and trackers separately, and a count
 * shown to the user has to come from the decision that was actually made rather
 * than from a guess applied afterwards. A host on both lists counts as a tracker:
 * that is the more specific and more privacy-relevant statement about it.
 */
export type RuleCategory = 'ad' | 'tracker'

/**
 * A rule that matches a host *and* a path prefix.
 *
 * Domain rules cannot reach two common cases, both confirmed on a real YouTube
 * watch page:
 *
 *   - **First-party ad endpoints.** `www.youtube.com/ptracking` is served by the
 *     site you are on, so the third-party test that protects ordinary pages
 *     exempts it.
 *   - **Mixed-purpose hosts.** `www.google.com/pagead/lvz` is ad telemetry, but
 *     blocking `google.com` outright would break Search.
 *
 * So these rules are checked against the full host+path and apply regardless of
 * first-party status. That is a sharper instrument than domain blocking and it
 * is kept deliberately short: every entry has to be justified against breaking
 * the site it targets.
 */
export interface PathRule {
  /** Host, matched with the same subdomain walk as domain rules. */
  readonly host: string
  /** Path prefix, matched case-insensitively against `url.pathname`. */
  readonly path: string
  readonly category: RuleCategory
}

export class FilterEngine {
  private readonly ads = new Set<string>()
  private readonly trackers = new Set<string>()
  private readonly malicious = new Set<string>()
  /** Hosts the user has chosen to allow, overriding every list. */
  private readonly allowed = new Set<string>()
  /** Extra rules the user typed, kept apart so they survive a list refresh. */
  private readonly custom = new Set<string>()

  loadBlocked(domains: readonly string[], category: RuleCategory = 'ad'): void {
    const target = category === 'tracker' ? this.trackers : this.ads
    for (const domain of domains) {
      const clean = normalise(domain)
      if (clean) target.add(clean)
    }
  }

  loadMalicious(domains: readonly string[]): void {
    for (const domain of domains) {
      const clean = normalise(domain)
      if (clean) this.malicious.add(clean)
    }
  }

  /** User-authored rules. Replaces the previous set rather than accumulating. */
  setCustomRules(domains: readonly string[]): void {
    this.custom.clear()
    for (const domain of domains) {
      const clean = normalise(domain)
      if (clean) this.custom.add(clean)
    }
  }

  setAllowedSites(hosts: readonly string[]): void {
    this.allowed.clear()
    for (const host of hosts) {
      const clean = normalise(host)
      if (clean) this.allowed.add(clean)
    }
  }

  get counts(): { blocked: number; malicious: number; custom: number } {
    return {
      blocked: this.ads.size + this.trackers.size,
      malicious: this.malicious.size,
      custom: this.custom.size
    }
  }

  /**
   * Which category a host falls in, or null if no rule covers it.
   *
   * Trackers are checked first so a host on both lists reports as the more
   * specific of the two.
   */
  categoryOf(host: string): RuleCategory | null {
    const clean = normalise(host)
    if (matches(this.trackers, clean)) return 'tracker'
    if (matches(this.ads, clean) || matches(this.custom, clean)) return 'ad'
    return null
  }

  /** Whether any list would block this host as a third-party resource. */
  isKnownAdHost(host: string): boolean {
    return this.categoryOf(host) !== null
  }

  loadPathRules(rules: readonly PathRule[]): void {
    for (const rule of rules) {
      const host = normalise(rule.host)
      if (host) this.pathRules.push({ ...rule, host, path: rule.path.toLowerCase() })
    }
  }

  /**
   * Whether a full URL matches a host+path rule.
   *
   * Checked *before* the first-party test in `NetworkPolicy`, which is the whole
   * point of these rules existing — the endpoints they target are served by the
   * site the user is on.
   */
  classifyUrl(url: string): RuleCategory | null {
    let host: string
    let path: string
    try {
      const parsed = new URL(url)
      host = normalise(parsed.host)
      path = parsed.pathname.toLowerCase()
    } catch {
      return null
    }
    if (host === '') return null

    for (const rule of this.pathRules) {
      if (!hostMatches(rule.host, host)) continue
      if (path.startsWith(rule.path)) return rule.category
    }
    return null
  }

  private readonly pathRules: PathRule[] = []

  /** Whether the *page* the user is on has been exempted by them. */
  isSiteAllowed(pageHost: string): boolean {
    return matches(this.allowed, normalise(pageHost))
  }

  isMalicious(host: string): boolean {
    return matches(this.malicious, normalise(host))
  }

  /**
   * Whether a sub-resource request should be blocked.
   *
   * Third-party only. A first-party request to a domain that happens to be on
   * the list is left alone: if someone deliberately visits an ad network's own
   * site, blocking it would look like the browser is broken.
   */
  shouldBlockRequest(requestHost: string, pageHost: string): boolean {
    return this.classifyRequest(requestHost, pageHost) !== null
  }

  /**
   * The category a request would be blocked under, or null to allow it.
   *
   * The single decision point for sub-resource blocking: `NetworkPolicy` records
   * whatever this returns, so the dashboard's ad and tracker counts are the
   * decisions themselves rather than a separate tally that could drift.
   */
  classifyRequest(requestHost: string, pageHost: string): RuleCategory | null {
    const request = normalise(requestHost)
    const page = normalise(pageHost)
    if (!request || !page) return null
    if (isSameSite(request, page)) return null
    return this.categoryOf(request)
  }
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '')
}

/**
 * Whether `host` is `rule` or a subdomain of it.
 *
 * A rule ending in `.*` matches the same name under any top-level domain:
 * `google.*` covers google.com, google.lk, google.co.uk. Google serves the same
 * ad endpoints from every country domain it operates, and a probe against a live
 * page found `google.lk/pagead/lvz` sailing past a rule written for
 * `google.com`. Listing ~190 country domains by hand was the alternative.
 */
function hostMatches(rule: string, host: string): boolean {
  if (rule.endsWith('.*')) {
    const base = rule.slice(0, -2)
    // `google.co.uk` and `google.com` both qualify; `notgoogle.com` does not,
    // and neither does `google.com.evil.example` — the name must own the tail.
    return new RegExp(`(^|\\.)${escapeRegExp(base)}(\\.[a-z]{2,}){1,2}$`).test(host)
  }
  return host === rule || host.endsWith(`.${rule}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Walks up the domain tree so a rule covers its subdomains. */
function matches(set: ReadonlySet<string>, host: string): boolean {
  if (host === '') return false
  if (set.has(host)) return true
  let index = host.indexOf('.')
  while (index !== -1) {
    const parent = host.slice(index + 1)
    if (set.has(parent)) return true
    index = host.indexOf('.', index + 1)
  }
  return false
}

/**
 * Approximate same-site test.
 *
 * Compares the last two labels, which is right for `example.com` but wrong for
 * multi-part suffixes like `co.uk` — there, `a.co.uk` and `b.co.uk` read as the
 * same site. The failure is conservative: it blocks *less*, never more, so the
 * worst outcome is an ad getting through rather than a page being broken.
 * A full Public Suffix List would fix it and is the obvious upgrade.
 */
function isSameSite(a: string, b: string): boolean {
  if (a === b) return true
  const tail = (host: string): string => host.split('.').slice(-2).join('.')
  return tail(a) === tail(b)
}
