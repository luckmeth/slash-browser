/**
 * How open tabs relate to one another.
 *
 * A navigation view, not an understanding one. Everything here comes from
 * addresses, titles and workspace membership — facts the browser already holds —
 * and the tree it produces is a way of finding a tab among forty, not a claim
 * about what the tabs mean. The spec this answers says it plainly: do not claim
 * semantic understanding beyond what the local data supports.
 *
 * So there is no topic modelling and no clustering by meaning. A site is a
 * branch, its sections are twigs, and that is the whole of the structure —
 * because that is the whole of what an address actually tells you.
 */

export interface RelatedTab {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly workspaceId: string
  readonly isActive?: boolean
}

export interface RelationLeaf {
  readonly kind: 'tab'
  readonly tab: RelatedTab
}

export interface RelationBranch {
  readonly kind: 'branch'
  /** What the branch is called — a host, or a section of one. */
  readonly label: string
  /** Stable across renders: the branch's own path within the tree. */
  readonly key: string
  readonly children: RelationNode[]
  /** Every tab beneath it, however deep. */
  readonly count: number
}

export type RelationNode = RelationLeaf | RelationBranch

/**
 * Below this a "section" is not a grouping, it is one tab with extra
 * indentation. Two tabs under `/docs` is a section worth drawing; one is not.
 */
const MIN_SECTION = 2

/** Hosts with a great many tabs still only earn one level of sections. */
const MAX_DEPTH = 1

/**
 * Groups tabs by site, then by the first path segment where that helps.
 *
 * `www.` is folded away and the registrable-ish domain is used, so
 * `docs.example.com` and `example.com` sit together — somebody with both open is
 * looking at one thing. Deeper structure is not attempted: a second path segment
 * is usually an article id, and a tree branching on those is noise wearing the
 * shape of information.
 */
export function buildRelations(tabs: readonly RelatedTab[]): RelationBranch[] {
  const byHost = new Map<string, RelatedTab[]>()

  for (const tab of tabs) {
    const host = siteOf(tab.url)
    if (host === null) continue
    const bucket = byHost.get(host)
    if (bucket) bucket.push(tab)
    else byHost.set(host, [tab])
  }

  const branches: RelationBranch[] = []
  for (const [host, hostTabs] of byHost) {
    branches.push({
      kind: 'branch',
      label: host,
      key: host,
      children: sectionsFor(host, hostTabs, MAX_DEPTH),
      count: hostTabs.length
    })
  }

  // Busiest site first: the reason to open this view is usually "where did that
  // tab go", and the site with fourteen tabs is where it went.
  branches.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  return branches
}

function sectionsFor(
  hostKey: string,
  tabs: readonly RelatedTab[],
  depth: number
): RelationNode[] {
  if (depth <= 0 || tabs.length < MIN_SECTION * 2) return tabs.map(asLeaf)

  const bySection = new Map<string, RelatedTab[]>()
  for (const tab of tabs) {
    const section = firstSegment(tab.url)
    const bucket = bySection.get(section)
    if (bucket) bucket.push(tab)
    else bySection.set(section, [tab])
  }

  const nodes: RelationNode[] = []
  const loose: RelatedTab[] = []

  for (const [section, sectionTabs] of bySection) {
    // A section of one is one tab with extra indentation. It goes back in the
    // flat list rather than earning a heading of its own.
    if (section === '' || sectionTabs.length < MIN_SECTION) {
      loose.push(...sectionTabs)
      continue
    }
    nodes.push({
      kind: 'branch',
      label: section,
      key: `${hostKey}/${section}`,
      children: sectionTabs.map(asLeaf),
      count: sectionTabs.length
    })
  }

  /*
   * One section holding everything is not a grouping.
   *
   * Twelve Wikipedia tabs all sit under `/wiki`, so the tree drew
   * `wikipedia.org → wiki → (twelve tabs)` — a level of indentation that
   * separated nothing from nothing. Found by looking at it rather than by a
   * test, and now covered by one.
   */
  if (nodes.length === 1 && loose.length === 0) return tabs.map(asLeaf)

  nodes.sort((a, b) => nodeCount(b) - nodeCount(a))
  return [...nodes, ...loose.map(asLeaf)]
}

function asLeaf(tab: RelatedTab): RelationLeaf {
  return { kind: 'tab', tab }
}

function nodeCount(node: RelationNode): number {
  return node.kind === 'branch' ? node.count : 1
}

/**
 * Suffixes that are two labels rather than one.
 *
 * A named list rather than the public suffix list, which is thousands of entries
 * and a dependency this does not earn. It covers what people actually have open;
 * anything missing costs one extra branch, which is visible and harmless.
 *
 * Getting this wrong in the other direction is not harmless, which is why the
 * list exists at all: without it `example.co.uk` truncates to `co.uk`, and every
 * unrelated British site in the window collapses into one branch. A test caught
 * exactly that.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'co.nz',
  'org.nz',
  'co.za',
  'com.br',
  'com.mx',
  'com.ar',
  'com.sg',
  'com.hk',
  'co.in',
  'co.kr',
  'com.tr',
  'com.cn',
  'com.tw'
])

/**
 * The site a tab belongs to, or null when it is not on the web.
 *
 * `www.` goes, and so does one level of subdomain — so `docs.example.com` and
 * `example.com` group together, because somebody with both open is looking at
 * one thing. What is kept is the registrable name plus its suffix, with
 * `TWO_LABEL_SUFFIXES` deciding how long that suffix is.
 */
export function siteOf(url: string): string | null {
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  if (host === '') return null

  const parts = host.split('.')
  if (parts.length <= 2) return host

  const lastTwo = parts.slice(-2).join('.')
  const keep = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2
  return parts.length <= keep ? host : parts.slice(-keep).join('.')
}

/** The first path segment, which is a site's own idea of a section. */
export function firstSegment(url: string): string {
  try {
    const path = new URL(url).pathname
    const segment = path.split('/').filter(Boolean)[0] ?? ''
    // A long segment is a slug, not a section. `/how-to-do-the-thing-in-2026`
    // as a heading is the article's title spelled badly.
    return segment.length > 0 && segment.length <= 24 ? segment : ''
  } catch {
    return ''
  }
}

/** How many tabs the tree holds, for the "N tabs across M sites" line. */
export function countTabs(branches: readonly RelationBranch[]): number {
  return branches.reduce((sum, branch) => sum + branch.count, 0)
}
