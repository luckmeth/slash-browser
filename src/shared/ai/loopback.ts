/**
 * Whether an endpoint is genuinely on this machine.
 *
 * ## Why this exists
 *
 * `AI_PROVIDER_CATALOGUE` marks the OpenAI-compatible provider `local: true`,
 * and the UI rendered that flag as *"Runs on this machine — nothing is sent to
 * a third party"*. But `local` is a claim about a **provider id**, not a fact
 * about a **destination**: the base URL beside it is a free-text field, and
 * `ProviderRegistry.connect` stores whatever is typed without looking at it. A
 * "local" provider pointed at `https://my-gpu-box.example.net/v1` therefore
 * carried a promise the browser had never checked and could not keep.
 *
 * Principle 8 is *never claim capability the architecture does not have*. So
 * the claim is now made about the address, and only when the address supports
 * it.
 *
 * ## The honest limit
 *
 * This reads the host as written. A `hosts` file that remaps `localhost` to a
 * remote address defeats it, and so would a DNS answer for a name that merely
 * looks local. Resolving the name before every request would close that gap and
 * is deliberately not done here — it would put a DNS lookup on a path that must
 * stay synchronous and pure. What this function promises is exactly "the
 * address the user gave names this machine", which is what the copy above it
 * should say.
 */

export type LoopbackVerdict =
  /** The address names this machine. Nothing sent here leaves it. */
  | 'loopback'
  /** The address names somewhere else, whatever the provider is called. */
  | 'remote'
  /** Not an address we can read — treated as remote by every caller. */
  | 'unparseable'

/**
 * IPv4 loopback is the whole `127.0.0.0/8` block, not just `127.0.0.1`.
 *
 * `127.1`, `127.0.0.2` and `127.255.255.254` all route to this machine, and a
 * check for the one familiar spelling would call the others remote — refusing a
 * genuinely local model rather than the reverse, but wrong either way.
 */
function isIpv4Loopback(host: string): boolean {
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return false
  if (!parts.every((part) => part !== '' && /^\d+$/.test(part))) return false
  const numbers = parts.map(Number)
  if (!numbers.every((value) => value >= 0 && value <= 255)) return false
  return numbers[0] === 127
}

/**
 * Whether this address names the machine the browser is running on.
 *
 * Hostnames are compared after stripping the brackets Node puts around IPv6
 * literals, and `localhost` is matched exactly — `localhost.evil.example` is a
 * perfectly ordinary remote name that happens to start with the right word, and
 * a prefix test would hand it the local badge.
 */
export function loopbackVerdict(baseUrl: string | null | undefined): LoopbackVerdict {
  if (baseUrl === null || baseUrl === undefined || baseUrl.trim() === '') return 'unparseable'

  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return 'unparseable'
  }

  // Only these two carry an address we can reason about. A `file:` or custom
  // scheme is not something to make a promise about either way.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'unparseable'

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return 'unparseable'
  if (host === 'localhost') return 'loopback'
  // IPv6 loopback, and the IPv4-mapped forms of it that Node will hand back.
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return 'loopback'
  if (host === '::ffff:127.0.0.1') return 'loopback'
  if (isIpv4Loopback(host)) return 'loopback'

  return 'remote'
}

/**
 * What to tell the user about where their text is going.
 *
 * Returned from one place so the two surfaces that make this claim cannot drift
 * apart — they did, and that is how the wrong one shipped.
 */
export function destinationLabel(verdict: LoopbackVerdict, host: string): string {
  switch (verdict) {
    case 'loopback':
      return 'stays on this machine'
    case 'remote':
      return `sent to ${host}`
    default:
      return 'destination unknown'
  }
}

/** The host part of an endpoint, for naming it in the UI. Empty when unreadable. */
export function endpointHost(baseUrl: string | null | undefined): string {
  if (baseUrl === null || baseUrl === undefined) return ''
  try {
    const url = new URL(baseUrl.trim())
    return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
  } catch {
    return ''
  }
}
