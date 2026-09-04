import { net } from 'electron'
import { mediaHeaders, type MediaRequestContext } from './requestHeaders'

export type { MediaRequestContext } from './requestHeaders'

/**
 * One request, built to look like the page's own.
 *
 * `useSessionCookies` is the part that is easy to miss: passing a session is
 * *not* enough on its own — Electron defaults that flag to false, so the
 * request goes out through the right network stack with the right proxy and no
 * cookies at all, which fails in exactly the same way as using the wrong
 * session while looking correct.
 */
export function openMediaRequest(
  url: string,
  context: MediaRequestContext | undefined,
  extra: Record<string, string> = {}
): ReturnType<typeof net.request> {
  const request = net.request({
    url,
    method: 'GET',
    redirect: 'manual',
    ...(context?.session ? { session: context.session, useSessionCookies: true } : {})
  })

  for (const [name, value] of Object.entries(mediaHeaders(context, url, extra))) {
    if (value !== '') request.setHeader(name, value)
  }
  return request
}

/**
 * A request, with its redirects actually followed.
 *
 * `redirect: 'manual'` does not mean "tell me about the redirect in the
 * response" — it means **the redirect is cancelled unless `followRedirect()` is
 * called synchronously during the `redirect` event**. Both downloaders were
 * written as though a 3xx would arrive as a response and be handled there, so
 * that code never ran and every redirecting fetch failed outright with
 * "Redirect was cancelled".
 *
 * It went unnoticed because ordinary file downloads rarely redirect. Streaming
 * CDNs redirect *every segment* — `SLASH_MEDIA_ACCESS_PROBE` found a real film
 * whose 1266 segments each 302 to a different edge host — so this single bug
 * failed every stream download on every such site, silently, no matter what
 * else was right.
 *
 * Manual is still the right mode: each hop is reported here, which is what
 * Redirect X-Ray and the Download Guardian exist to surface, and what lets the
 * caller know which host actually served the bytes.
 */
export async function sendMediaRequest(
  url: string,
  context: MediaRequestContext | undefined,
  extra: Record<string, string> = {},
  maxRedirects = 10
): Promise<{
  response: Electron.IncomingMessage
  request: ReturnType<typeof net.request>
  /** Where the bytes actually came from, after every hop. */
  finalUrl: string
}> {
  const request = openMediaRequest(url, context, extra)
  let finalUrl = url
  let hops = 0

  const response = await new Promise<Electron.IncomingMessage>((resolve, reject) => {
    request.on('redirect', (_status: number, _method: string, redirectUrl: string) => {
      hops += 1
      if (hops > maxRedirects) {
        request.abort()
        reject(new Error('Too many redirects'))
        return
      }
      finalUrl = redirectUrl
      // Synchronously, or Chromium cancels the redirect for us.
      request.followRedirect()
    })
    request.on('response', resolve)
    request.on('error', reject)
    request.on('abort', () => reject(new Error('aborted')))
    request.end()
  })

  return { response, request, finalUrl }
}
