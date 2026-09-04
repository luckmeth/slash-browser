import type { TabError } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { Icon } from '../../components/Icon'

/**
 * What the user sees when a page will not load.
 *
 * Chromium's own version says things like `ERR_NAME_NOT_RESOLVED`, which tells
 * someone who already knows what it means something they could have guessed.
 * More importantly it cannot tell the difference between a site being down and
 * **Slash refusing to load it** — and a browser that silently blocks a request
 * and then shows a generic failure page is indistinguishable from a broken one.
 */
export function ErrorPage({
  error,
  tabId
}: {
  error: TabError
  tabId: string
}): React.JSX.Element {
  const explained = explain(error)
  const host = hostOf(error.url)

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md">
        <div className="mb-3 flex items-center gap-2">
          <Icon
            name={explained.blocked ? 'shield' : 'warning'}
            size={18}
            className={
              explained.blocked ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
            }
          />
          <h1 className="text-lg font-medium">{explained.title}</h1>
        </div>

        <p className="text-sm text-[var(--color-text-muted)]">{explained.body}</p>

        {host && (
          <p className="mt-3 truncate font-mono text-xs text-[var(--color-text-muted)]">{host}</p>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() =>
              void window.browser.invoke('nav:reload', { tabId, ignoreCache: true })
            }
            className="cursor-default rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Try again
          </button>
        </div>

        {/*
          Deliberately a signpost rather than a button. Shield is a toolbar
          popover, not a panel this can open, and a button that cannot go where
          it claims is worse than a sentence saying where to look.
        */}
        {explained.blocked && (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            To let this site through, open the shield icon in the toolbar and turn blocking off for
            it.
          </p>
        )}

        {/*
          The raw code, kept and not hidden. It is meaningless to most people and
          the only useful thing in the world to someone searching for it.
        */}
        <p className="mt-6 font-mono text-[11px] text-[var(--color-text-muted)]">
          {error.description || 'unknown error'} ({error.code})
        </p>
      </div>
    </div>
  )
}

/**
 * Chromium error codes, in plain language.
 *
 * Only the ones people actually hit are named. Everything else falls through to
 * an honest "we do not know", which is better than a confident guess that sends
 * someone to check their wifi when the site is down.
 */
function explain(error: TabError): { title: string; body: string; blocked: boolean } {
  switch (error.code) {
    case -20: // ERR_BLOCKED_BY_CLIENT
      return {
        title: 'Slash Shield blocked this',
        body: 'This request matched an advertising, tracking or known-malicious rule, so it was refused before it left your machine. The site is not necessarily down.',
        blocked: true
      }
    case -105: // ERR_NAME_NOT_RESOLVED
      return {
        title: 'That address could not be found',
        body: 'No server answers to this name. It is usually a typo in the address, or a site that no longer exists.',
        blocked: false
      }
    case -106: // ERR_INTERNET_DISCONNECTED
      return {
        title: 'You appear to be offline',
        body: 'Slash could not reach the network at all. Check your connection and try again.',
        blocked: false
      }
    case -7: // ERR_TIMED_OUT
      return {
        title: 'The site took too long to answer',
        body: 'The server was reachable but never finished responding. It may be overloaded.',
        blocked: false
      }
    case -102: // ERR_CONNECTION_REFUSED
      return {
        title: 'The site refused the connection',
        body: 'Something answered at that address and declined to talk. The server may be down or blocking you.',
        blocked: false
      }
    case -501: // ERR_INSECURE_RESPONSE
    case -200: // ERR_CERT_COMMON_NAME_INVALID
    case -201: // ERR_CERT_DATE_INVALID
      return {
        title: 'This site’s certificate is not valid',
        body: 'The connection could not be verified as genuinely belonging to this site, so Slash stopped rather than sending anything to it.',
        blocked: false
      }
    default:
      return {
        title: 'This page did not load',
        body: 'Slash could not load this address and does not have a more specific explanation than the code below.',
        blocked: false
      }
  }
}
