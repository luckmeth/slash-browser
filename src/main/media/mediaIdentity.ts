/**
 * Telling "the same video again" from "a different video".
 *
 * The ledger used to key media by its URL, which is wrong on almost every site
 * that matters. A player re-requests its manifest with a fresh token every few
 * minutes, and `…/master.m3u8?token=ABC` and `…/master.m3u8?token=XYZ` are the
 * same film — so the panel grew a second row, then a third, each pointing at
 * the same thing under a different signature.
 *
 * The fix is **not** to drop the query string. Query parameters are how a great
 * many CDNs identify the resource at all: `?id=1234`, `?quality=1080`,
 * `?file=movie.mp4`. Throwing them away merges genuinely different videos into
 * one entry, which is a worse failure than showing one twice — the user picks a
 * row and gets a different film.
 *
 * So this removes a **named list of parameters that carry credentials or
 * clocks**, and keeps everything else. A parameter nobody recognises is assumed
 * to matter, because assuming otherwise loses information that cannot be
 * recovered.
 *
 * Pure, and every rule here is a test.
 */

/**
 * Parameters that authenticate or expire a request rather than name a resource.
 *
 * Two families: signatures and their inputs, and cache-busters. Both change on
 * every request for the same file, and neither says anything about which file
 * it is.
 */
const EPHEMERAL_PARAMS: ReadonlySet<string> = new Set([
  // Signatures and tokens
  'token',
  'access_token',
  'auth',
  'authorization',
  'hmac',
  'key',
  'md5',
  'nonce',
  'pot',
  'sig',
  'signature',
  'st',
  'verify',
  // Validity windows
  'e',
  'exp',
  'expire',
  'expires',
  'expiry',
  'ttl',
  'valid_from',
  'valid_to',
  // AWS and friends
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-security-token',
  'x-amz-signature',
  'x-amz-signedheaders',
  'policy',
  'key-pair-id',
  // Session and client identity
  'cid',
  'session',
  'sessionid',
  'sid',
  'ip',
  'ipbits',
  // Cache-busters
  '_',
  'cb',
  'cachebust',
  'cachebuster',
  'rnd',
  'random'
])

/**
 * A stable name for the thing behind a URL.
 *
 * Not a URL, and deliberately not reversible: it exists to be compared, and the
 * address to actually fetch is kept alongside it — always the most recent one,
 * because that is the one whose token has not expired.
 *
 * Returns the input unchanged when it cannot be parsed. An unparseable address
 * is its own identity; guessing at one would risk merging two of them.
 */
export function mediaIdentity(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  // A fragment is never sent to a server and never identifies a different
  // resource — except in this engine, where `#rep=` names a DASH quality, so it
  // is kept when it is ours.
  const fragment = /^rep=/.test(parsed.hash.slice(1)) ? parsed.hash : ''

  const kept: [string, string][] = []
  for (const [name, value] of parsed.searchParams) {
    if (EPHEMERAL_PARAMS.has(name.toLowerCase())) continue
    kept.push([name, value])
  }
  // Sorted, because a player that reorders its parameters between requests is
  // still asking for the same file.
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const query = kept.map(([name, value]) => `${name}=${value}`).join('&')
  // Host lowercased and the default port dropped: `EXAMPLE.com:443` and
  // `example.com` are one host.
  const host = parsed.port === '' ? parsed.hostname.toLowerCase() : `${parsed.hostname.toLowerCase()}:${parsed.port}`

  return `${parsed.protocol}//${host}${parsed.pathname}${query === '' ? '' : `?${query}`}${fragment}`
}

/**
 * Whether two addresses point at the same thing.
 *
 * A convenience over `mediaIdentity`, and the shape most callers actually want.
 */
export function isSameMedia(a: string, b: string): boolean {
  return mediaIdentity(a) === mediaIdentity(b)
}
