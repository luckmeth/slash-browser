import { SEARCH_ENGINES, type SearchEngineId } from '@shared/constants'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import { NEW_TAB_URL, isInternalUrl } from '@shared/types/tab'

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
export interface CustomSearchEngine {
  readonly id: string
  readonly name: string
  readonly keyword: string
  readonly url: string
}

export function resolveInput(
  rawInput: string,
  engineId: string,
  customEngines: readonly CustomSearchEngine[] = []
): ResolvedInput {
  const input = rawInput.trim()

  if (input === '') return { kind: 'internal', url: NEW_TAB_URL }
  if (isInternalUrl(input)) return { kind: 'internal', url: input }

  // A keyword search wins over every other reading of the text, because the
  // user has explicitly named where the query should go. Checked before the
  // address rules so "gh some/path" searches rather than resolving as a host.
  const keyworded = matchKeyword(input, customEngines)
  if (keyworded) return keyworded

  // Anything with whitespace inside is prose, not an address.
  const hasWhitespace = /\s/.test(input)

  const scheme = extractScheme(input)
  if (scheme) {
    if (BLOCKED_SCHEMES.has(scheme)) return search(input, engineId, customEngines)
    if (NAVIGABLE_SCHEMES.has(scheme) && !hasWhitespace) {
      return { kind: 'url', url: input }
    }
    // A scheme we recognise but do not navigate (mailto:, tel:, custom app
    // protocols) is handed to the caller as a URL; NavigationGuards decides
    // whether to pass it to the OS.
    if (!hasWhitespace && /^[a-z][a-z0-9+.-]*:/i.test(input)) {
      return { kind: 'url', url: input }
    }
    return search(input, engineId, customEngines)
  }

  if (hasWhitespace) return search(input, engineId, customEngines)

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

  return search(input, engineId, customEngines)
}

/**
 * Matches "<keyword> query" against the user's own engines.
 *
 * The trailing space is what makes this safe: without it a keyword of "gh"
 * would swallow `github.com`, and a keyword of "a" would swallow almost
 * everything. A keyword alone with nothing after it is *not* a match either —
 * it is far more likely to be the start of a domain than an empty search.
 */
function matchKeyword(
  input: string,
  engines: readonly CustomSearchEngine[]
): ResolvedInput | null {
  const separator = input.search(/\s/)
  if (separator <= 0) return null

  const candidate = input.slice(0, separator).toLowerCase()
  const rest = input.slice(separator + 1).trim()
  if (rest === '') return null

  const engine = engines.find((e) => e.keyword.toLowerCase() === candidate)
  if (!engine) return null

  const encoded = encodeURIComponent(rest)
  // A URL without a placeholder gets the query appended: it is the commonest
  // way to get this wrong, and searching the wrong place silently would be a
  // worse answer than being forgiving about it.
  const url = engine.url.includes('%s')
    ? engine.url.replace('%s', encoded)
    : `${engine.url}${engine.url.includes('?') ? '&' : '?'}q=${encoded}`

  return { kind: 'search', query: rest, url }
}

function search(
  query: string,
  engineId: string,
  customEngines: readonly CustomSearchEngine[] = []
): ResolvedInput {
  // One of the user's own engines may be the default — see the setting's note
  // on why that matters for a search partnership.
  const custom = customEngines.find((entry) => entry.id === engineId)
  if (custom) {
    const encoded = encodeURIComponent(query)
    return {
      kind: 'search',
      query,
      url: custom.url.includes('%s')
        ? custom.url.replace('%s', encoded)
        : `${custom.url}${custom.url.includes('?') ? '&' : '?'}q=${encoded}`
    }
  }

  // Falls back to the *configured default*, not to a hardcoded engine. This
  // used to name DuckDuckGo directly, which meant any path that lost the
  // setting — a stale renderer copy, an unrecognised id from an older profile —
  // silently searched somewhere the user had not chosen, while Settings went on
  // showing their real preference. A default that disagrees with the schema's
  // default is indistinguishable from the setting being ignored.
  const engine =
    SEARCH_ENGINES[engineId as SearchEngineId] ??
    SEARCH_ENGINES[DEFAULT_SETTINGS.searchEngineId as SearchEngineId]
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
