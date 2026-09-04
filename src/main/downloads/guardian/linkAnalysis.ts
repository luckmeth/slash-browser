import {
  DOWNLOADABLE_MEDIA_EXTENSIONS,
  type DownloadCandidate,
  type LinkVerdict
} from '@shared/types/downloadGuardian'

/**
 * Classifying the download links on a page.
 *
 * Pure, because these are judgement calls about someone's safety and the only
 * way to hold them steady is to pin every one to a test. A heuristic nobody can
 * examine is indistinguishable from a guess, and this one is allowed to be
 * wrong — it is not allowed to be wrong *confidently*.
 */

/** Extensions that mean "this is a file to save", not "this is a page". */
const FILE_EXTENSIONS = new Set([
  'exe',
  'msi',
  'msix',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'appimage',
  'apk',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'iso',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'epub',
  ...DOWNLOADABLE_MEDIA_EXTENSIONS
])

/** Extensions that run code when opened. Worth naming explicitly to the user. */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe',
  'msi',
  'msix',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'appimage',
  'apk',
  'bat',
  'cmd',
  'ps1',
  'sh',
  'scr'
])

/** Words that claim to be a download. Matched against visible link text. */
const DOWNLOAD_WORDS = /\b(download|télécharger|descargar|herunterladen|скачать|下载|get it|install)\b/i

/**
 * Multi-part public suffixes common enough to matter.
 *
 * Not a full Public Suffix List — that is a 15,000-entry file updated
 * continuously, and shipping a stale copy would be worse than this. The
 * consequence of getting one wrong is a link labelled "third-party" that was
 * actually first-party, which is a conservative failure: the user is told to look
 * more carefully at something that was fine.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.cn',
  'com.tr',
  'co.in',
  'co.za',
  'com.mx',
  'com.sg',
  'com.hk'
])

/**
 * The domain a site is identified by, for same-site comparison.
 *
 * `docs.example.co.uk` and `cdn.example.co.uk` are the same operator;
 * `example.co.uk` and `example-downloads.co.uk` are not.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')

  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.')
  return lastTwo
}

/** Lowercase extension from a URL path, or null. */
export function extensionOf(url: string): string | null {
  try {
    const path = new URL(url).pathname
    const match = /\.([a-z0-9]{1,8})$/i.exec(path)
    return match?.[1] ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

/** Whether a URL looks like it points at a file rather than a page. */
export function looksLikeFile(url: string): boolean {
  const extension = extensionOf(url)
  return extension !== null && FILE_EXTENSIONS.has(extension)
}

export interface LinkInput {
  url: string
  label: string
  /**
   * Whether the page's own markup placed this link inside advertising.
   *
   * Determined in the page by the scan script — ancestor `<iframe>`, or an
   * element whose class or id names an ad slot. Structural, not a guess about
   * the link itself.
   */
  insideAdMarkup: boolean
}

export interface AnalysisContext {
  pageUrl: string
  /** Known advertising/tracking host predicate, from the existing Shield engine. */
  isKnownAdHost: (host: string) => boolean
}

/**
 * Classifies one link.
 *
 * The ordering of the checks *is* the policy: advertising markup outranks a
 * plausible extension, and a text/destination mismatch outranks being on the
 * same site, because that mismatch is the actual mechanic of a deceptive
 * download button.
 */
export function analyseLink(link: LinkInput, context: AnalysisContext): DownloadCandidate | null {
  let host: string
  try {
    const parsed = new URL(link.url, context.pageUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    host = parsed.host
  } catch {
    return null
  }

  const label = link.label.replace(/\s+/g, ' ').trim()
  const extension = extensionOf(link.url)
  const claimsDownload = DOWNLOAD_WORDS.test(label)
  const isFile = looksLikeFile(link.url)

  // Not download-shaped at all: neither a file nor claiming to be one. Reporting
  // every link on the page would bury the four that matter.
  if (!isFile && !claimsDownload) return null

  let pageDomain: string
  try {
    pageDomain = registrableDomain(new URL(context.pageUrl).host)
  } catch {
    // An unparseable page URL means "same site" cannot be established, so every
    // link is treated as off-site — the conservative direction.
    pageDomain = ''
  }
  const linkDomain = registrableDomain(host)
  const sameSite = pageDomain !== '' && pageDomain === linkDomain

  const reasons: string[] = []
  let verdict: LinkVerdict

  if (link.insideAdMarkup) {
    verdict = 'advertisement'
    reasons.push('This link sits inside advertising markup on the page.')
  } else if (context.isKnownAdHost(host)) {
    verdict = 'advertisement'
    reasons.push(`${host} is on a list of known advertising or tracking hosts.`)
  } else if (claimsDownload && !isFile && !sameSite) {
    // The classic deceptive button: says Download, is not a file, and leaves the
    // site. Any one of those alone is ordinary; together they are the pattern.
    verdict = 'suspicious'
    reasons.push('The link text offers a download but the destination is a page on another site.')
  } else if (sameSite) {
    verdict = 'likely-official'
    reasons.push(`Hosted on ${linkDomain}, the same site as this page.`)
  } else {
    verdict = 'third-party'
    reasons.push(`Hosted on ${linkDomain}, which is not this site.`)
    if (claimsDownload) {
      reasons.push('Common for a legitimate mirror or CDN, but worth confirming before running it.')
    }
  }

  if (extension) reasons.push(`Destination looks like a .${extension} file.`)
  if (extension && EXECUTABLE_EXTENSIONS.has(extension)) {
    reasons.push('This file type runs code when opened. Consider scanning it first.')
  }
  if (claimsDownload && isFile && !sameSite && verdict === 'third-party') {
    reasons.push('Based on detected signals only — Slash cannot confirm this is the official file.')
  }

  return { url: link.url, label: label || host, host, extension, verdict, reasons }
}

/**
 * Orders and de-duplicates candidates for display.
 *
 * Likely-official first, because the point of the panel is to answer "which one
 * do I click". Duplicates by URL collapse — a page linking the same installer
 * from a button and a text link is offering one download, not two.
 */
export function rankCandidates(candidates: readonly DownloadCandidate[]): DownloadCandidate[] {
  const order: Record<LinkVerdict, number> = {
    'likely-official': 0,
    'third-party': 1,
    advertisement: 2,
    suspicious: 3
  }

  const seen = new Set<string>()
  const unique: DownloadCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue
    seen.add(candidate.url)
    unique.push(candidate)
  }

  return unique.sort((a, b) => order[a.verdict] - order[b.verdict])
}

/**
 * A sentence describing what was found, or why nothing was.
 *
 * The count is stated first because "there are 4 download links on this page" is
 * itself the warning — a page with one is unremarkable, a page with four is the
 * situation this feature exists for.
 */
export function summarise(candidates: readonly DownloadCandidate[]): string | null {
  if (candidates.length === 0) {
    return 'No download links were found on this page.'
  }
  const official = candidates.filter((c) => c.verdict === 'likely-official').length
  const flagged = candidates.filter(
    (c) => c.verdict === 'advertisement' || c.verdict === 'suspicious'
  ).length

  const parts = [
    `There ${candidates.length === 1 ? 'is' : 'are'} ${candidates.length} download link${candidates.length === 1 ? '' : 's'} on this page.`
  ]
  if (official > 0) parts.push(`${official} appear${official === 1 ? 's' : ''} to be hosted by this site.`)
  if (flagged > 0) {
    parts.push(
      `${flagged} ${flagged === 1 ? 'appears' : 'appear'} to be advertising or potentially misleading — review carefully.`
    )
  }
  return parts.join(' ')
}
