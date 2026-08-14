/**
 * Presentation helpers for URLs, shared by both processes.
 *
 * The omnibox (renderer) and the main process must agree on how a URL is shown,
 * so this lives in shared rather than being reimplemented on each side.
 */

/** Strips the scheme and a lone trailing slash: `https://example.com/` → `example.com`. */
export function formatUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url
    const shown = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
    return shown.endsWith('/') && parsed.pathname === '/' ? parsed.host : shown
  } catch {
    return url
  }
}

/** Host only, for compact contexts like a tab tooltip or a download's source. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** True when the origin is one Chromium treats as a secure context. */
export function isSecureUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1'
    )
  } catch {
    return false
  }
}
