/**
 * The headers a media download has to carry, and why.
 *
 * Split from the module that makes the request so it can be tested: `npm test`
 * runs pure logic only and nothing here may import electron. Which headers go
 * out is the entire difference between a download that works and a 403, and it
 * is exactly the kind of thing that is wrong in a way no typecheck notices.
 */

import type { Session } from 'electron'

/**
 * Who a download is pretending to be, and it is not pretending.
 *
 * Every fetch this engine makes used to be anonymous: `net.request({ url })`,
 * which means the default session, no cookies, no `Referer`, no `Origin`, and
 * Electron's own user agent rather than the browser's. For an ordinary file on
 * an ordinary server that is fine, and it is why nobody noticed. For media it
 * is fatal, and in three different ways at once:
 *
 *  - **Hotlink protection.** Almost every video CDN checks `Referer`, and the
 *    ones serving films check it hardest. A request with none is refused with
 *    403 no matter how correct the rest of it is.
 *  - **Cookies.** A stream's playlist is very often behind a session cookie the
 *    embed page was issued seconds earlier. The default session has never
 *    visited the site and has none.
 *  - **The client's identity.** `googlevideo.com` will not serve a media URL to
 *    something that does not look like the browser the URL was minted for.
 *
 * The fix is not to forge anything. It is to make the download **the same
 * request the page itself would have made** — the tab's session, the tab's
 * cookies, the tab's user agent, and the page as the referrer, because the page
 * genuinely is the referrer. Anything less is a different client asking, and
 * these servers are entitled to notice.
 */
export interface MediaRequestContext {
  /**
   * The tab's session, so cookies, proxy and TLS match the page.
   *
   * Held as a `Session` rather than a partition name because a `WebContents`
   * exposes the object and not the string it was created from, and inventing a
   * lookup would be a second source of truth for something already in hand.
   */
  readonly session?: Session
  /**
   * The partition that session came from, when it is known.
   *
   * A `Session` cannot be written to a database and cannot survive a restart. A
   * partition name can, and asking Chromium for it again gets the same cookie
   * jar the page used — which is the only correct way for a resumed download to
   * still be authenticated. `private` is never recorded.
   */
  readonly partition?: string
  /** The page the media belongs to. Sent as `Referer` — it is the referrer. */
  readonly referer?: string
  /** That page's origin. */
  readonly origin?: string
  /** The tab's user agent, not Electron's. */
  readonly userAgent?: string
}

/**
 * The referrer Chromium will actually allow us to send.
 *
 * Not a nicety. Chromium's default referrer policy is
 * `strict-origin-when-cross-origin`, and the network service **verifies** the
 * referrer it is handed against what that policy would produce. Hand it a
 * full-path referrer on a cross-origin request and the request is cancelled
 * outright with `ERR_BLOCKED_BY_CLIENT` — no server ever sees it, and the
 * failure looks exactly like an ad blocker or a hostile CDN.
 *
 * That is measured, not reasoned about. Against one real film CDN,
 * `SLASH_MEDIA_ACCESS_PROBE` recorded: no referrer → 200; `https://site.tld/`
 * → 200; `https://site.tld/movies/the-full-path` → ERR_BLOCKED_BY_CLIENT. The
 * host was identical in all three. Only the path differed.
 *
 * So this is what a browser sends, because it is the same rule a browser
 * follows:
 *
 *  - same origin → the full page URL
 *  - cross-origin, no protocol downgrade → the page's origin alone
 *  - https page → http media → nothing, which is also the honest answer
 */
export function refererFor(pageUrl: string, pageOrigin: string, targetUrl: string): string | null {
  let page: URL
  let target: URL
  try {
    page = new URL(pageUrl)
    target = new URL(targetUrl)
  } catch {
    return null
  }

  if (page.origin === target.origin) return pageUrl
  if (page.protocol === 'https:' && target.protocol !== 'https:') return null
  return `${pageOrigin}/`
}

/**
 * The headers the page's own player would have sent, minus the ones we may not.
 *
 * `Sec-Fetch-Dest`, `Sec-Fetch-Mode` and `Sec-Fetch-Site` are **deliberately
 * absent**, and their absence was measured rather than assumed. They are
 * forbidden header names: Chromium reserves them for itself, and a
 * `net.request` carrying one is rejected before it leaves the machine with
 * `ERR_INVALID_ARGUMENT`. Sending them made every download with a known origin
 * fail — worse than the 403 they were added to fix, and invisible to typecheck,
 * lint and 861 unit tests.
 *
 * What is left is what a server can actually check and Chromium will actually
 * let us send.
 */
export function mediaHeaders(
  context: MediaRequestContext | undefined,
  targetUrl: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  }

  if (context?.userAgent) headers['User-Agent'] = context.userAgent
  if (context?.referer && context.origin) {
    const referer = refererFor(context.referer, context.origin, targetUrl)
    if (referer !== null) headers['Referer'] = referer
  }
  // `Origin` is safe where a path-bearing `Referer` is not: it is already just
  // an origin, so there is nothing for the policy to trim.
  if (context?.origin) headers['Origin'] = context.origin

  return { ...headers, ...extra }
}
