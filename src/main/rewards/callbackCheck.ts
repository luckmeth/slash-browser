import { timingSafeEqual } from 'node:crypto'

/**
 * Whether a loopback OAuth callback should be acted on.
 *
 * Pure and separate from `RewardsService` because it is the security decision
 * in the sign-in path, and a decision of that kind should be readable and
 * testable on its own rather than buried in an HTTP handler that needs a real
 * browser and a real Google account to exercise.
 *
 * **Why a missing state is accepted.** Supabase runs the OAuth exchange with
 * Google itself and keeps its own `state` for that leg; what comes back to the
 * loopback listener is `?code=…` with no echo of the value we sent. Measured
 * against the live endpoint — requiring one would reject every genuine sign-in.
 *
 * State was never the binding here in any case. This is the loopback flow of
 * RFC 8252, where the protection is **PKCE**: the authorization code cannot be
 * exchanged without the `code_verifier` this process generated and never
 * transmitted, so a code injected by anything else is inert. The listener is
 * also single-use, bound to 127.0.0.1, and on an ephemeral port chosen at the
 * moment of the request.
 *
 * A state that is present and *wrong* is still refused, because that is a
 * genuine mismatch rather than an absence.
 */
export type CallbackVerdict =
  | { accept: true }
  | { accept: false; reason: 'no-code' | 'state-mismatch' }

export function checkCallback(input: {
  code: string
  state: string
  expectedState: string
}): CallbackVerdict {
  if (input.code === '') return { accept: false, reason: 'no-code' }

  // Absent is fine; present must match.
  if (input.state !== '' && !constantTimeEquals(input.state, input.expectedState)) {
    return { accept: false, reason: 'state-mismatch' }
  }

  return { accept: true }
}

/**
 * Compared without leaking the position of the first difference.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are checked
 * first — that leaks only the length, which is fixed by construction here.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Pulls the authorization code out of an address the user pasted.
 *
 * Written to be forgiving about *where* the code is, because the whole point is
 * that the browser did not land where it was supposed to. Supabase puts it in
 * the query string on the loopback path and in the fragment when it falls back
 * to its own `site_url`, and somebody copying an address bar may bring either,
 * with or without the surrounding URL.
 *
 * It is deliberately not forgiving about *what* it accepts: an implicit-flow
 * `#access_token=…` is refused rather than mistaken for a code, because that is
 * a live credential and exchanging it is not what this path does.
 */
export function extractCode(pasted: string): string {
  const text = pasted.trim()
  if (text === '') return ''

  // Query and fragment both, without needing the string to be a valid URL —
  // a half-copied address should still give up its code.
  for (const separator of ['?', '#']) {
    const at = text.indexOf(separator)
    if (at === -1) continue
    const params = new URLSearchParams(text.slice(at + 1))
    const code = params.get('code')
    if (code !== null && code.trim() !== '') return code.trim()
  }

  // A bare code, pasted on its own. Constrained to the shape Supabase issues so
  // that pasting an access token, an email address or a sentence does not get
  // sent to the token endpoint as if it were a code.
  if (/^[A-Za-z0-9._~-]{16,256}$/.test(text) && !text.includes('access_token')) return text

  return ''
}

/**
 * The sign-in code from a redirect the browser passed through, or nothing.
 *
 * Two hops in the chain carry a `code` and only one of them is ours:
 *
 *  - `https://<project>.supabase.co/auth/v1/callback?code=…` is **Google's**
 *    code, on its way to the auth service. Exchanging that against the PKCE
 *    endpoint fails, and consuming it here would abort the real sign-in.
 *  - Whatever the auth service redirects to afterwards carries the code this
 *    browser is waiting for — the loopback address when the flow resolved, and
 *    the service's own configured site address when it did not.
 *
 * So the provider's own host is skipped by name, and so is Google's. Anything
 * else carrying a code is ours to finish.
 */
export function codeFromRedirect(url: string, providerBaseUrl: string): string {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }

  let providerHost: string
  try {
    providerHost = new URL(providerBaseUrl).hostname.toLowerCase()
  } catch {
    // An unconfigured or malformed base URL must not turn into "trust
    // everything" — without a host to exclude there is no safe answer.
    return ''
  }

  if (host === providerHost) return ''
  if (host === 'google.com' || host.endsWith('.google.com')) return ''

  return extractCode(url)
}
