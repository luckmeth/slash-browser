import { SEARCH_ENGINES, type SearchEngineId } from '@shared/constants'
import { NEW_TAB_URL } from '@shared/types/tab'

export type ResolvedInput =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'search'; readonly url: string; readonly query: string }
  | { readonly kind: 'internal'; readonly url: string }

/** Schemes we will navigate a tab to directly. */
const NAVIGABLE_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'blob:'])

/**
 * Schemes that must never be navigated to from the omnibox.
 *
 * `javascript:` is the important one: pasting a `javascript:` URL into the
 * address bar is the classic self-XSS vector, where a user is socially
 * engineered into running an attacker's script in the context of a site they are
 * logged into. Browsers strip it, and so do we — it falls through to search.
 */
const BLOCKED_SCHEMES = new Set(['javascript:', 'vbscript:'])

// A bare hostname: labels separated by dots, ending in a 2+ letter TLD, with an
// optional port and path. Deliberately conservative — anything ambiguous should
// become a search, since a wrong search is a minor annoyance while a wrong
// navigation loses what the user typed.
const BARE_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i
const HOST_WITH_PORT = /^([a-z0-9.-]+)(:\d{1,5})(\/.*)?$/i

/**
 * Turns raw omnibox text into either a navigation target or a search.
 *
 * This lives in the main process, not the renderer, so the rule is defined and
 * tested once. It is pure and has no Electron import, which is what allows the
 * unit tests to cover it directly.
 */
export function resolveInput(rawInput: string, engineId: SearchEngineId): ResolvedInput {
  const input = rawInput.trim()

  if (input === '') return { kind: 'internal', url: NEW_TAB_URL }
  if (input.startsWith('adaptive://')) return { kind: 'internal', url: input }

  // Anything with whitespace inside is prose, not an address.
  const hasWhitespace = /\s/.test(input)

  const scheme = extractScheme(input)
  if (scheme) {
    if (BLOCKED_SCHEMES.has(scheme)) return search(input, engineId)
    if (NAVIGABLE_SCHEMES.has(scheme) && !hasWhitespace) {
      return { kind: 'url', url: input }
    }
    // A scheme we recognise but do not navigate (mailto:, tel:, custom app
    // protocols) is handed to the caller as a URL; NavigationGuards decides
    // whether to pass it to the OS.
    if (!hasWhitespace && /^[a-z][a-z0-9+.-]*:/i.test(input)) {
      return { kind: 'url', url: input }
    }
    return search(input, engineId)
  }

  if (hasWhitespace) return search(input, engineId)

  // localhost and host:port — common enough in development to be worth handling
  // before the generic domain rule, since "localhost:3000" has no dot.
  if (input === 'localhost' || input.startsWith('localhost/') || input.startsWith('localhost:')) {
    return { kind: 'url', url: `http://${input}` }
  }
  const withPort = HOST_WITH_PORT.exec(input)
  if (withPort) return { kind: 'url', url: `http://${input}` }

  // IPv4 literal, with optional path.
  const [hostPart = ''] = input.split('/')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart)) {
    return { kind: 'url', url: `http://${input}` }
  }

  if (BARE_DOMAIN.test(hostPart)) {
    return { kind: 'url', url: `https://${input}` }
  }

  return search(input, engineId)
}

function search(query: string, engineId: SearchEngineId): ResolvedInput {
  const engine = SEARCH_ENGINES[engineId] ?? SEARCH_ENGINES.duckduckgo
  return {
    kind: 'search',
    query,
    url: engine.url.replace('%s', encodeURIComponent(query))
  }
}

function extractScheme(input: string): string | null {
  // "localhost:3000" and "example.com:8080/x" parse as a scheme followed by a
  // path if read naively. Digits immediately after the colon mean it is a port,
  // not a scheme — no real scheme is followed directly by a bare number.
  if (/^[a-z][a-z0-9+.-]*:\d+(\/|\?|#|$)/i.test(input)) return null
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(input)
  return match?.[1]?.toLowerCase() ?? null
}
