/**
 * Host handling for saved sign-ins, as a pure function.
 *
 * Split out of `PasswordVault` because that file imports `electron` for
 * `safeStorage` and therefore cannot be loaded by the test runner. This is the
 * rule that decides whether a saved sign-in is offered on the page in front of
 * you, so it is worth being able to test directly.
 */

/**
 * Host, lower-cased and without `www.`.
 *
 * Sites move between the bare domain and the www subdomain freely, and nobody
 * thinks of those as two different accounts. Accepts either a bare host or a
 * full URL so callers do not each have to remember which they are holding.
 */
export function normaliseHost(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return ''
  try {
    const host = trimmed.includes('://') ? new URL(trimmed).hostname : trimmed
    return host.replace(/^www\./, '')
  } catch {
    return trimmed.replace(/^www\./, '')
  }
}
