/**
 * Choosing what to download from a GitHub release, and proving it arrived intact.
 *
 * This module decides on a URL that will be **written to disk and executed**,
 * which makes it the security boundary of the whole managed-install feature.
 * Everything it does is therefore pure and tested: a mistake here is not a
 * broken download, it is running somebody else's binary.
 */

/** The only repository this will install from. */
export const YTDLP_REPO = 'yt-dlp/yt-dlp'
export const YTDLP_RELEASE_API = `https://api.github.com/repos/${YTDLP_REPO}/releases/latest`

/** The asset wanted on Windows, by exact name. */
const ASSET_NAME = 'yt-dlp.exe'
/** The file listing SHA-512 sums for every asset in the release. */
const CHECKSUM_ASSET = 'SHA2-512SUMS'

/** A PyInstaller build of yt-dlp is ~18 MB. These bound "obviously wrong". */
const MIN_BYTES = 4 * 1024 * 1024
const MAX_BYTES = 200 * 1024 * 1024

export interface ReleaseChoice {
  readonly version: string
  readonly url: string
  readonly checksumUrl: string | null
  readonly sizeBytes: number
}

/**
 * The download URL for this platform's yt-dlp, or a reason there is none.
 *
 * Every field of the release document is treated as untrusted, including the
 * download URLs — the request that produced it is pinned to the official API,
 * but a redirect, a proxy or a compromised response should not be able to point
 * this at an arbitrary host. So the host and path are checked against the
 * repository rather than being taken on the strength of where the JSON came
 * from.
 */
export function chooseAsset(release: unknown): ReleaseChoice | { error: string } {
  if (!release || typeof release !== 'object') return { error: 'Unreadable release information.' }
  const root = release as { tag_name?: unknown; assets?: unknown }

  const version = typeof root.tag_name === 'string' ? root.tag_name : ''
  if (version === '') return { error: 'That release has no version.' }

  const assets = Array.isArray(root.assets) ? root.assets : []
  const find = (name: string): { url: string; size: number } | null => {
    for (const raw of assets) {
      if (!raw || typeof raw !== 'object') continue
      const asset = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown }
      if (asset.name !== name) continue
      const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
      if (!isOfficialDownload(url)) continue
      return { url, size: typeof asset.size === 'number' ? asset.size : 0 }
    }
    return null
  }

  const binary = find(ASSET_NAME)
  if (!binary) return { error: `That release has no ${ASSET_NAME} from the official repository.` }
  if (binary.size < MIN_BYTES || binary.size > MAX_BYTES) {
    return { error: `${ASSET_NAME} is ${binary.size} bytes, which is not a plausible size.` }
  }

  return {
    version,
    url: binary.url,
    // Optional: an older release may not carry one, and a missing checksum is
    // reported by the installer rather than silently skipped.
    checksumUrl: find(CHECKSUM_ASSET)?.url ?? null,
    sizeBytes: binary.size
  }
}

/**
 * Whether a URL is a release download from the official repository.
 *
 * Exact host, and a path that begins with this repository's release downloads.
 * `startsWith` on the whole URL would not do: `https://github.com.evil.test/…`
 * starts with neither, but `https://github.com/yt-dlp/yt-dlp/releases/download`
 * appearing anywhere in a longer host is exactly the trick this refuses.
 */
export function isOfficialDownload(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.hostname.toLowerCase() !== 'github.com') return false
  return parsed.pathname.startsWith(`/${YTDLP_REPO}/releases/download/`)
}

/**
 * The published SHA-512 for one asset.
 *
 * The file is `<hex>  <name>` per line, two spaces by convention but any run of
 * whitespace in practice. Returns null when the name is absent rather than
 * guessing, because a checksum that silently matched nothing would make the
 * verification below pass for any bytes at all.
 */
export function checksumFor(sums: string, name = ASSET_NAME): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{128})\s+\*?(\S+)$/i.exec(line.trim())
    if (match && match[2] === name) return match[1]!.toLowerCase()
  }
  return null
}


/**
 * How often a managed yt-dlp is worth re-checking.
 *
 * Two weeks, from the release cadence rather than a round number: extractor
 * fixes ship every few weeks (2026.08.19 came nine days after 2026.07.04, and
 * its notes name the YouTube extractor). Checking daily would be a request a
 * fresh install makes unasked for no benefit; checking never is how the
 * first-run install quietly becomes useless a month later.
 */
export const YTDLP_REFRESH_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Whether to look for a newer yt-dlp now.
 *
 * Pure and clock-injected because every clause is a decision about making an
 * unattended network request, and principle 2 does not let those be decided
 * inside an async method nobody can test.
 *
 * The clause that matters most is `managed`. A yt-dlp the user installed
 * themselves — pip, scoop, winget — belongs to them and to whatever else on
 * their machine uses it. Slash replacing it would be reaching outside its own
 * directory to change somebody else's software, which it does not do however
 * stale the copy is.
 */
export function shouldRefreshYtDlp(options: {
  enabled: boolean
  /** False for a copy the user installed themselves. */
  managed: boolean
  lastCheckedAt: number
  now: number
  intervalMs?: number
}): boolean {
  if (!options.enabled) return false
  if (!options.managed) return false

  const interval = options.intervalMs ?? YTDLP_REFRESH_INTERVAL_MS
  const elapsed = options.now - options.lastCheckedAt

  // A clock that moved backwards — a corrected system time, a restored
  // machine — reads as a negative age. Treated as due rather than as never
  // due, because the alternative is a copy that can never update again.
  if (elapsed < 0) return true
  return elapsed >= interval
}
