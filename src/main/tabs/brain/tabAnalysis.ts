import type { Tab } from '@shared/types/tab'
import { isInternalUrl } from '@shared/types/tab'
import {
  IDLE_CLOSE_HOURS,
  MIN_GROUP_SIZE,
  SIMILARITY_THRESHOLD,
  type CloseSuggestion,
  type DuplicateSet,
  type TabAnalysis,
  type TabGroup
} from '@shared/types/tabBrain'

/**
 * Finding the structure in a set of open tabs.
 *
 * Entirely pure and clock-injected, for the same reason the resource policy
 * engine is: these rules decide what the browser offers to close, and every one
 * of them has to be examinable in a test rather than observed by opening twenty
 * tabs and squinting.
 *
 * The approach is deliberately unglamorous — token overlap on titles and URLs,
 * single-link clustering. No embeddings, no model. It runs in under a
 * millisecond on a hundred tabs, works offline, and needs no consent, which
 * matters more here than the marginal accuracy a language model would add.
 */

/**
 * Words too common to indicate a topic.
 *
 * Without this, every group would be joined by "the", "home" and "login", and a
 * cluster called "Home | Official Site" would tell the user nothing.
 */
const STOP_WORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','with','at','by','from','is','are','be',
  'this','that','it','as','was','were','has','have','had','not','but','you','your','my','our',
  'www','com','net','org','io','co','html','htm','php','aspx','index','page','pages','home',
  'search','login','signin','sign','log','new','free','best','top','how','what','why','get',
  'official','site','website','online','app','web','download','downloads','docs','doc','wiki',
  'en','us','uk','http','https','amp','utm','ref','id','view','list','all','more','about'
])

/** Tracking parameters that never change which page you are looking at. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|ref$|referrer$|source$|igshid$|si$|spm$)/i

/**
 * A URL reduced to the page it identifies.
 *
 * Strips the fragment, tracking parameters, a trailing slash and `www.`, so two
 * tabs reached by different campaign links are recognised as the same page. The
 * fragment goes because `#section-2` is a position in a document rather than a
 * different document — noted in `DuplicateSet.exact` so the user can disagree.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    url.host = url.host.replace(/^www\./i, '')
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
    }
    // Sorted so ?a=1&b=2 and ?b=2&a=1 canonicalise identically.
    url.searchParams.sort()
    let text = url.toString()
    if (text.endsWith('/') && url.pathname !== '/') text = text.slice(0, -1)
    return text
  } catch {
    return raw.trim()
  }
}

/**
 * The meaningful words in a tab, for comparison.
 *
 * Drawn from the title *and* the URL path: a title alone misses that two pages
 * live under `/visa/`, and a path alone misses everything about pages served
 * from opaque ids.
 */
export function tokenize(
  tab: Pick<Tab, 'title' | 'url'>,
  options: { includeHost?: boolean } = {}
): Set<string> {
  let path = ''
  let host = ''
  try {
    const url = new URL(tab.url)
    path = decodeURIComponent(url.pathname)
    host = url.host.replace(/^www\./i, '')
  } catch {
    // A malformed URL still has a title worth reading.
  }

  // The registrable-ish host label counts as a token so tabs from one site
  // cluster even when their titles share nothing.
  //
  // Callers judging *topic* rather than grouping should switch it off: being on
  // the same website is weak evidence of being about the same thing — football
  // and coral reefs are both on Wikipedia — and it is strong enough to swamp the
  // title words when the comparison set is small.
  const hostLabel = options.includeHost === false ? '' : (host.split('.').slice(0, -1).pop() ?? '')

  const words = `${tab.title} ${path} ${hostLabel}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && word.length <= 24 && !STOP_WORDS.has(word))
    .filter((word) => !/^\d+$/.test(word))

  return new Set(words)
}

/**
 * Jaccard overlap of two token sets.
 *
 * Chosen over counting shared words because it normalises for length: a
 * ten-word title sharing three words with a forty-word one is a weaker signal
 * than a four-word title sharing three, and raw counts cannot tell the
 * difference.
 */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** Tabs that are the same page opened more than once. */
export function findDuplicates(tabs: readonly Tab[]): DuplicateSet[] {
  const byCanonical = new Map<string, Tab[]>()
  for (const tab of tabs) {
    if (isInternalUrl(tab.url)) continue
    const key = canonicalUrl(tab.url)
    const bucket = byCanonical.get(key)
    if (bucket) bucket.push(tab)
    else byCanonical.set(key, [tab])
  }

  const sets: DuplicateSet[] = []
  for (const [url, members] of byCanonical) {
    if (members.length < 2) continue
    const first = members[0]!
    sets.push({
      url,
      title: first.title || url,
      tabIds: members.map((tab) => tab.id),
      exact: members.every((tab) => tab.url === first.url)
    })
  }
  // Biggest pile-ups first: they are the ones worth acting on.
  return sets.sort((a, b) => b.tabIds.length - a.tabIds.length)
}

/**
 * Clusters tabs into probable projects.
 *
 * Single-link agglomeration: a tab joins a cluster if it is similar enough to
 * *any* member, not to all of them. That is the right shape for browsing, where
 * a project is a chain — visa requirements → embassy appointment → flight dates
 * — whose ends may share nothing with each other while every link is obvious.
 *
 * Pinned tabs are excluded. A pinned tab is a permanent fixture the user has
 * already organised by hand, and sweeping it into a suggested group would offer
 * to reorganise the one thing they explicitly arranged.
 */
export function clusterTabs(tabs: readonly Tab[]): TabGroup[] {
  const eligible = tabs.filter((tab) => !isInternalUrl(tab.url) && !tab.isPinned)
  const tokens = new Map<string, Set<string>>()
  for (const tab of eligible) tokens.set(tab.id, tokenize(tab))

  // Drop tokens carried by *every* tab before comparing.
  //
  // Twenty tabs on one site all share the site's name, and every Wikipedia page
  // is titled "… - Wikipedia". Such a token raises the similarity of every pair
  // identically, so it cannot distinguish one group from another — it can only
  // fuse everything into a single cluster. This was found by a live probe, where
  // an article about sourdough joined a cluster about databases on the strength
  // of the word "wikipedia" alone.
  //
  // The trade-off, stated plainly: four tabs whose *only* common term is the
  // site name will now not be grouped. That is the safer error. A missing
  // suggestion is ignorable; a group that offers to move unrelated tabs into a
  // workspace together is not.
  if (eligible.length >= 4) {
    const frequency = new Map<string, number>()
    for (const tab of eligible) {
      for (const token of tokens.get(tab.id) ?? []) {
        frequency.set(token, (frequency.get(token) ?? 0) + 1)
      }
    }
    for (const [token, count] of frequency) {
      if (count < eligible.length) continue
      for (const set of tokens.values()) set.delete(token)
    }
  }

  // Union-find over the similarity graph.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    return root
  }
  for (const tab of eligible) parent.set(tab.id, tab.id)

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!
      const b = eligible[j]!
      const score = similarity(tokens.get(a.id)!, tokens.get(b.id)!)
      if (score < SIMILARITY_THRESHOLD) continue
      const rootA = find(a.id)
      const rootB = find(b.id)
      if (rootA !== rootB) parent.set(rootA, rootB)
    }
  }

  const clusters = new Map<string, Tab[]>()
  for (const tab of eligible) {
    const root = find(tab.id)
    const bucket = clusters.get(root)
    if (bucket) bucket.push(tab)
    else clusters.set(root, [tab])
  }

  const groups: TabGroup[] = []
  for (const [root, members] of clusters) {
    if (members.length < MIN_GROUP_SIZE) continue
    const name = nameCluster(members, tokens)
    groups.push({
      id: `group-${root}`,
      name,
      tabIds: members.map((tab) => tab.id),
      reason: describeCluster(members, tokens),
      hosts: rankHosts(members)
    })
  }
  return groups.sort((a, b) => b.tabIds.length - a.tabIds.length)
}

/**
 * Names a cluster from the terms its tabs actually share.
 *
 * Ranked by how many members carry the term, so the name reflects the whole
 * group rather than whichever tab happened to be first. Falls back to the
 * dominant host, which is at least true — an invented topic name would not be.
 */
export function nameCluster(
  members: readonly Tab[],
  tokens: ReadonlyMap<string, Set<string>>
): string {
  const frequency = new Map<string, number>()
  for (const tab of members) {
    for (const token of tokens.get(tab.id) ?? []) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
    }
  }

  const shared = [...frequency.entries()]
    // A term in only one tab says nothing about the group.
    .filter(([, count]) => count >= Math.max(2, Math.ceil(members.length * 0.4)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([token]) => token)

  if (shared.length === 0) {
    const [host] = rankHosts(members)
    return host ? `Tabs on ${host}` : 'Related tabs'
  }
  return shared.map(capitalise).join(' · ')
}

function describeCluster(
  members: readonly Tab[],
  tokens: ReadonlyMap<string, Set<string>>
): string {
  const hosts = rankHosts(members)
  const name = nameCluster(members, tokens)
  const hostPart =
    hosts.length === 1
      ? `all on ${hosts[0]}`
      : `across ${hosts.length} site${hosts.length === 1 ? '' : 's'}`
  return `${members.length} tabs ${hostPart}, sharing terms like ${name.toLowerCase()}.`
}

/** Hosts in a cluster, most frequent first. */
export function rankHosts(members: readonly Tab[]): string[] {
  const counts = new Map<string, number>()
  for (const tab of members) {
    try {
      const host = new URL(tab.url).host.replace(/^www\./i, '')
      counts.set(host, (counts.get(host) ?? 0) + 1)
    } catch {
      // Unparseable URLs contribute no host.
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([host]) => host)
}

/**
 * Tabs the user could close without losing anything they are using.
 *
 * The exclusions are the important part. Pinned and protected tabs never appear:
 * both are explicit statements that the tab matters, and overriding either would
 * make the feature untrustworthy the first time it happened. Audible tabs are
 * excluded too — something is playing, so the tab is in use whatever its idle
 * timestamp says.
 */
export function suggestClosures(
  tabs: readonly Tab[],
  duplicates: readonly DuplicateSet[],
  now: number
): CloseSuggestion[] {
  const suggestions: CloseSuggestion[] = []
  const claimed = new Set<string>()

  const keepable = (tab: Tab): boolean =>
    !tab.isPinned && !tab.isProtected && !tab.isAudible && !isInternalUrl(tab.url)

  // Duplicates first, keeping the most recently used copy of each page.
  for (const set of duplicates) {
    const members = set.tabIds
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is Tab => tab !== undefined && keepable(tab))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)

    for (const tab of members.slice(1)) {
      claimed.add(tab.id)
      suggestions.push({
        tabId: tab.id,
        title: tab.title || tab.url,
        url: tab.url,
        reason: set.exact
          ? 'This exact page is open in another tab.'
          : 'The same page is open in another tab, reached by a different link.',
        idleHours: idleHours(tab, now)
      })
    }
  }

  for (const tab of tabs) {
    if (claimed.has(tab.id) || !keepable(tab)) continue
    const idle = idleHours(tab, now)
    if (idle < IDLE_CLOSE_HOURS) continue
    suggestions.push({
      tabId: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
      reason: `Not looked at for ${Math.floor(idle / 24)} day${Math.floor(idle / 24) === 1 ? '' : 's'}.`,
      idleHours: idle
    })
  }

  return suggestions.sort((a, b) => b.idleHours - a.idleHours)
}

function idleHours(tab: Tab, now: number): number {
  return Math.max(0, (now - tab.lastActiveAt) / 3_600_000)
}

/** The whole analysis, in one pass. */
export function analyseTabs(tabs: readonly Tab[], now: number): TabAnalysis {
  const duplicates = findDuplicates(tabs)
  const groups = clusterTabs(tabs)
  const closeSuggestions = suggestClosures(tabs, duplicates, now)

  const grouped = new Set(groups.flatMap((group) => group.tabIds))
  const ungroupedTabIds = tabs
    .filter((tab) => !isInternalUrl(tab.url) && !grouped.has(tab.id))
    .map((tab) => tab.id)

  return {
    tabCount: tabs.length,
    groups,
    duplicates,
    closeSuggestions,
    ungroupedTabIds,
    summary: summarise(tabs.length, groups, duplicates, closeSuggestions)
  }
}

function summarise(
  tabCount: number,
  groups: readonly TabGroup[],
  duplicates: readonly DuplicateSet[],
  closures: readonly CloseSuggestion[]
): string {
  if (tabCount <= 1) return 'Open a few tabs and Slash will look for the structure in them.'

  const parts: string[] = []
  if (groups.length > 0) {
    parts.push(
      `Found ${groups.length} probable project${groups.length === 1 ? '' : 's'} across ${tabCount} tabs.`
    )
  } else {
    parts.push(`No clear projects among ${tabCount} tabs — they look unrelated.`)
  }
  const duplicateTabs = duplicates.reduce((total, set) => total + set.tabIds.length - 1, 0)
  if (duplicateTabs > 0) {
    parts.push(`${duplicateTabs} duplicate tab${duplicateTabs === 1 ? '' : 's'}.`)
  }
  if (closures.length > 0) {
    parts.push(`${closures.length} could be closed. Nothing closes without your say-so.`)
  }
  return parts.join(' ')
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
