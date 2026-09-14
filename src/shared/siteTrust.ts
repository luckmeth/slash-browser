/**
 * Site Trust: every security signal the browser already holds about one site,
 * in one place, each one explained.
 *
 * Deliberately **not** a score. A number out of ten is a judgement the browser
 * cannot defend: it would have to weigh "12 trackers blocked" against "camera
 * allowed" against "no redirects", and any weighting is an opinion presented as
 * a measurement. Worse, a high score reads as a promise of safety that nothing
 * here can make — a site with no trackers and clean redirects can still be a
 * phishing page.
 *
 * So every row is a fact with its provenance, and the strongest thing the view
 * says overall is which of those facts are worth a second look.
 *
 * Nothing here computes a signal. The shield, Redirect X-Ray, the permission
 * store and the download list all already know these things; this arranges what
 * they report and writes the sentence explaining it.
 */

export type TrustTone = 'good' | 'neutral' | 'caution'

export interface TrustRow {
  readonly id: string
  readonly label: string
  /** The finding, in as few words as it can honestly be put. */
  readonly value: string
  /** Why this is what it is, and what Slash did about it. Always present. */
  readonly explanation: string
  readonly tone: TrustTone
}

export interface TrustSignals {
  /** The page's address. Everything here is about this one site. */
  readonly url: string
  /** Requests the shield cancelled on this page, split as the shield splits them. */
  readonly blocked: {
    readonly ads: number
    readonly trackers: number
    readonly popups: number
    readonly redirects: number
  }
  /** Whether the user has exempted this site from blocking. */
  readonly siteAllowed: boolean
  /** Whether the blocker is on at all. */
  readonly blockingEnabled: boolean
  /** Hops in the chain that led here, excluding the destination itself. */
  readonly redirectHops: number
  /** True when any hop in that chain was a known ad or tracking host. */
  readonly redirectThroughTracker: boolean
  /** Permissions currently granted to this origin. */
  readonly grants: readonly { kind: string; policy: string; expiresAt: number | null }[]
  /** Permission requests this origin made that were refused. */
  readonly denied: readonly string[]
  /** Downloads from this host that arrived with an executable extension. */
  readonly flaggedDownloads: number
}

/** Permission kinds worth naming even when nothing was granted. */
const SENSITIVE_KINDS = ['camera', 'microphone', 'geolocation']

export function buildTrustReport(signals: TrustSignals): TrustRow[] {
  const rows: TrustRow[] = []

  // --- connection ------------------------------------------------------------
  const scheme = schemeOf(signals.url)
  if (scheme === 'https') {
    rows.push({
      id: 'https',
      label: 'Connection',
      value: 'Encrypted (HTTPS)',
      // Precise about what TLS does and does not tell you. "Secure" is the word
      // every browser used to use here and it taught a generation of people that
      // a padlock meant a site was trustworthy.
      explanation:
        'Traffic between this browser and the site is encrypted, so nothing between ' +
        'you can read it. That says nothing about who runs the site.',
      tone: 'good'
    })
  } else if (scheme === 'http') {
    rows.push({
      id: 'https',
      label: 'Connection',
      value: 'Not encrypted (HTTP)',
      explanation:
        'Anything sent to or from this site travels in the open, including anything ' +
        'you type into it. Anyone on the same network can read it.',
      tone: 'caution'
    })
  } else {
    rows.push({
      id: 'https',
      label: 'Connection',
      value: 'Local page',
      explanation: 'This page is part of the browser and makes no network connection.',
      tone: 'neutral'
    })
  }

  // --- blocking --------------------------------------------------------------
  const totalBlocked =
    signals.blocked.ads + signals.blocked.trackers + signals.blocked.popups
  if (!signals.blockingEnabled) {
    rows.push({
      id: 'blocking',
      label: 'Ads and trackers',
      value: 'Blocking is off',
      explanation:
        'Content blocking is switched off for every site, so nothing was filtered here. ' +
        'This is a setting, not something about this site.',
      tone: 'caution'
    })
  } else if (signals.siteAllowed) {
    rows.push({
      id: 'blocking',
      label: 'Ads and trackers',
      value: 'Allowed on this site',
      explanation:
        'You exempted this site from blocking, so its requests were not filtered. ' +
        'You can undo that from the shield.',
      tone: 'caution'
    })
  } else if (totalBlocked > 0) {
    rows.push({
      id: 'blocking',
      label: 'Ads and trackers',
      value: `${totalBlocked} blocked`,
      explanation:
        describeBlocked(signals.blocked) +
        ' Each was matched against the filter lists and cancelled before it was sent.',
      tone: 'good'
    })
  } else {
    rows.push({
      id: 'blocking',
      label: 'Ads and trackers',
      value: 'None blocked',
      explanation:
        'Nothing on this page matched the filter lists. That can mean the page ' +
        'carries no trackers, or that it carries ones the lists do not know.',
      tone: 'neutral'
    })
  }

  // --- redirects -------------------------------------------------------------
  if (signals.redirectHops === 0) {
    rows.push({
      id: 'redirects',
      label: 'Redirects',
      value: 'None',
      explanation: 'You arrived here directly, without being passed through another site.',
      tone: 'good'
    })
  } else {
    rows.push({
      id: 'redirects',
      label: 'Redirects',
      value: `${signals.redirectHops} ${signals.redirectHops === 1 ? 'hop' : 'hops'}`,
      explanation: signals.redirectThroughTracker
        ? 'You were passed through another site on the way here, and at least one hop ' +
          'was a host the filter lists know as a tracker. Redirect X-Ray has the chain.'
        : 'You were passed through another site on the way here. That is ordinary for ' +
          'links and sign-ins; Redirect X-Ray has the full chain.',
      tone: signals.redirectThroughTracker ? 'caution' : 'neutral'
    })
  }

  // --- permissions -----------------------------------------------------------
  if (signals.grants.length === 0) {
    rows.push({
      id: 'permissions',
      label: 'Permissions',
      value: 'None granted',
      explanation:
        'This site has no access to your camera, microphone, location or anything else ' +
        'that needs asking for.',
      tone: 'good'
    })
  } else {
    const sensitive = signals.grants.filter((grant) => SENSITIVE_KINDS.includes(grant.kind))
    rows.push({
      id: 'permissions',
      label: 'Permissions',
      value: signals.grants.map((grant) => grant.kind).join(', '),
      explanation:
        `Granted ${signals.grants.map((grant) => `${grant.kind} (${grant.policy})`).join(', ')}. ` +
        'Each can be withdrawn from the permissions panel, which also offers to reload ' +
        'the tab — Chromium caches some grants inside the page.',
      tone: sensitive.length > 0 ? 'caution' : 'neutral'
    })
  }

  if (signals.denied.length > 0) {
    rows.push({
      id: 'denied',
      label: 'Refused',
      value: `${signals.denied.length} ${signals.denied.length === 1 ? 'request' : 'requests'}`,
      explanation:
        `This site asked for ${unique(signals.denied).join(', ')} and was refused. ` +
        'It can ask again; refusing is not permanent unless you chose "Never".',
      tone: 'neutral'
    })
  }

  // --- downloads -------------------------------------------------------------
  if (signals.flaggedDownloads > 0) {
    rows.push({
      id: 'downloads',
      label: 'Downloads',
      value: `${signals.flaggedDownloads} flagged`,
      explanation:
        'A file from this site arrived with an extension Windows will run on a ' +
        'double-click, so it was marked before you could open it. That is a caution ' +
        'about the kind of file, not a verdict about its contents — nothing here ' +
        'scans a file.',
      tone: 'caution'
    })
  } else {
    rows.push({
      id: 'downloads',
      label: 'Downloads',
      value: 'No warnings',
      explanation:
        'Nothing downloaded from this site carried an extension Windows runs directly.',
      tone: 'good'
    })
  }

  return rows
}

/**
 * The one-line summary above the rows.
 *
 * Says what is worth a second look, and nothing more. It never says a site is
 * safe: no signal here can support that, and a browser that says it is teaching
 * somebody to stop checking.
 */
export function trustSummary(rows: readonly TrustRow[]): string {
  const cautions = rows.filter((row) => row.tone === 'caution')
  if (cautions.length === 0) {
    return 'Nothing here needs your attention. This is what Slash can see, not a verdict on the site.'
  }
  return `${cautions.length} thing${cautions.length === 1 ? '' : 's'} worth a look: ${cautions
    .map((row) => row.label.toLowerCase())
    .join(', ')}.`
}

function describeBlocked(blocked: TrustSignals['blocked']): string {
  const parts: string[] = []
  if (blocked.ads > 0) parts.push(`${blocked.ads} ${blocked.ads === 1 ? 'advert' : 'adverts'}`)
  if (blocked.trackers > 0) {
    parts.push(`${blocked.trackers} ${blocked.trackers === 1 ? 'tracker' : 'trackers'}`)
  }
  if (blocked.popups > 0) {
    parts.push(`${blocked.popups} ${blocked.popups === 1 ? 'pop-up' : 'pop-ups'}`)
  }
  return `${parts.join(', ')} on this page.`
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function schemeOf(url: string): 'https' | 'http' | 'other' {
  if (url.startsWith('https://')) return 'https'
  if (url.startsWith('http://')) return 'http'
  return 'other'
}
