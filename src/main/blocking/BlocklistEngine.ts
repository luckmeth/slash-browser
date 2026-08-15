/**
 * Domain-based request blocking.
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
export class BlocklistEngine {
  private readonly blocked = new Set<string>()
  private readonly malicious = new Set<string>()
  /** Hosts the user has chosen to allow, overriding both lists. */
  private readonly allowed = new Set<string>()

  loadBlocked(domains: readonly string[]): void {
    for (const domain of domains) {
      const clean = normalise(domain)
      if (clean) this.blocked.add(clean)
    }
  }

  loadMalicious(domains: readonly string[]): void {
    for (const domain of domains) {
      const clean = normalise(domain)
      if (clean) this.malicious.add(clean)
    }
  }

  setAllowedSites(hosts: readonly string[]): void {
    this.allowed.clear()
    for (const host of hosts) {
      const clean = normalise(host)
      if (clean) this.allowed.add(clean)
    }
  }

  get counts(): { blocked: number; malicious: number } {
    return { blocked: this.blocked.size, malicious: this.malicious.size }
  }

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
    const request = normalise(requestHost)
    const page = normalise(pageHost)
    if (!request || !page) return false
    if (isSameSite(request, page)) return false
    return matches(this.blocked, request)
  }
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '')
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
