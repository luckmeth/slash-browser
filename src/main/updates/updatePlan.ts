/**
 * What may be downloaded and installed, and from where.
 *
 * The browser has shipped check-only until now for a good reason: an
 * auto-installer with nothing to verify against is an unauthenticated way to
 * put code on somebody's machine, and this build is not code-signed.
 *
 * This does not pretend to solve that. What it does is the same thing the
 * yt-dlp install already does in this codebase, and states the difference:
 *
 * - the feed is fetched over **TLS from a host the user configured**, and is
 *   empty by default, so nothing is contacted until somebody asks for it;
 * - the package must come from **that same host**, or from GitHub's release
 *   URLs under the exact path a release asset has;
 * - the bytes are checked against a **SHA-512 published in the feed** before
 *   anything is run, and a mismatch deletes the file rather than warning;
 * - and the installer is **handed to the user**, not run silently.
 *
 * What that buys is integrity: the package is what the publisher published, and
 * a proxy or a mirror cannot substitute a different one. What it does not buy
 * is authenticity independent of the server — anybody who controls the feed
 * host controls both the checksum and the file. Code signing is what fixes
 * that, and the signed path (`isSignedBuild`, `verifyUpdateCodeSignature`)
 * stays exactly where it was for when a certificate exists.
 *
 * Pure so every one of these rules is tested rather than reasoned about.
 */

export interface FeedEntry {
  version: string
  releaseUrl?: string | null
  fileUrl?: string | null
  sha512?: string | null
  size?: number | null
  notes?: string | null
}

export interface InstallPlan {
  version: string
  fileUrl: string
  /** Lower-case hex, whatever the feed used. */
  sha512: string
  /** 0 when the feed did not say. A stated size is checked; an absent one is not invented. */
  size: number
  fileName: string
}

export type PlanVerdict =
  | { readonly ok: true; readonly plan: InstallPlan }
  | { readonly ok: false; readonly problem: string }

/** A Windows installer, and nothing else. Rejecting by extension is crude and correct. */
const INSTALLER = /\.exe$/i
const HEX_512 = /^[0-9a-f]{128}$/i
const BASE64_512 = /^[A-Za-z0-9+/]{86}==$/

/** Two hosts, because a release asset redirects from one to the other. */
const GITHUB_HOSTS = ['github.com', 'objects.githubusercontent.com']

/** 1 GB. An installer larger than this is a mistake, not a browser. */
export const MAX_PACKAGE_BYTES = 1_073_741_824

/**
 * Normalises a published checksum to lower-case hex.
 *
 * electron-updater writes base64 in `latest.yml`; a hand-written feed will use
 * hex. Accepting both and comparing in one form is better than accepting one
 * and silently failing every feed that uses the other.
 */
export function normaliseSha512(value: string): string | null {
  const text = value.trim()
  if (HEX_512.test(text)) return text.toLowerCase()
  if (BASE64_512.test(text)) return Buffer.from(text, 'base64').toString('hex')
  return null
}

/**
 * Whether a package address may be fetched, given the feed it was named by.
 *
 * The rule is deliberately narrow: the host that served the feed, or a GitHub
 * release asset. Anything else means a feed can send this browser to fetch an
 * executable from an arbitrary host, which is precisely the thing being
 * avoided. Exact host comparison, so `github.com.evil.test` fails it.
 */
export function packageHostAllowed(fileUrl: string, feedUrl: string): boolean {
  let file: URL
  let feed: URL
  try {
    file = new URL(fileUrl)
    feed = new URL(feedUrl)
  } catch {
    return false
  }

  if (file.protocol !== 'https:') return false
  if (file.hostname === feed.hostname) return true

  return (
    GITHUB_HOSTS.includes(file.hostname) &&
    (file.pathname.includes('/releases/download/') || file.hostname === GITHUB_HOSTS[1])
  )
}

/** The file name to write, taken from the address and reduced to one component. */
export function packageFileName(fileUrl: string, version: string): string {
  let name: string
  try {
    name = decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() ?? '')
  } catch {
    name = ''
  }
  // Anything path-like is discarded rather than sanitised: this is a name from
  // the network, and the only safe treatment of one is to not use it.
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '')
  return INSTALLER.test(clean) && clean.length <= 120 ? clean : `Slash-Setup-${version}.exe`
}

/**
 * Turns a feed entry into something installable, or says why not.
 *
 * A feed with no `fileUrl` or no `sha512` is **not an error** — it is the
 * check-only feed this browser has always understood, and the caller falls
 * back to pointing at the release page. It is a refusal only when a feed
 * offers a package it cannot substantiate.
 */
export function planInstall(entry: FeedEntry, feedUrl: string): PlanVerdict {
  const fileUrl = (entry.fileUrl ?? '').trim()
  const sha512 = (entry.sha512 ?? '').trim()

  if (fileUrl === '' || sha512 === '') {
    return {
      ok: false,
      problem:
        'This release does not publish a package and a checksum, so Slash cannot install it for you. Open the release page and download it there.'
    }
  }

  if (!packageHostAllowed(fileUrl, feedUrl)) {
    return {
      ok: false,
      problem:
        'The update package is hosted somewhere Slash will not fetch an executable from — it must come from the same host as the update feed, or from a GitHub release.'
    }
  }

  const digest = normaliseSha512(sha512)
  if (digest === null) {
    return { ok: false, problem: 'The published checksum is not a SHA-512, so nothing can be verified against it.' }
  }

  const size = Number(entry.size ?? 0)
  if (!Number.isFinite(size) || size < 0 || size > MAX_PACKAGE_BYTES) {
    return { ok: false, problem: 'The published package size is not plausible for an installer.' }
  }

  return {
    ok: true,
    plan: {
      version: entry.version,
      fileUrl,
      sha512: digest,
      size: Math.floor(size),
      fileName: packageFileName(fileUrl, entry.version)
    }
  }
}
