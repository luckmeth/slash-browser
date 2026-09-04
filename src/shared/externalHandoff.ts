/**
 * Sites known to refuse sign-in from browsers they do not recognise.
 *
 * Google checks User-Agent Client Hints, and the measured value here is empty —
 * `navigator.userAgentData.brands` is `[]`, not a list missing a product name.
 * That metadata comes from Chromium's embedder identity and Electron exposes no
 * API to populate it. Google allowlists browsers; Brave and Vivaldi were added
 * to that list, they did not disguise themselves.
 *
 * The measurement, and why the User-Agent string is not the cause, is in
 * main/sessions/SessionHardening.ts and docs/testing/google-signin.md.
 *
 * Rather than impersonate Chrome to get past the check, the browser says what is
 * happening and offers to hand the page to the user's default browser. That is
 * honest, it always works, and it does not involve claiming to be software this
 * is not.
 */
export interface HandoffHint {
  readonly host: string
  /**
   * Only offer the hand-off on paths starting with this.
   *
   * Without it a hint covers a whole site, and a browser that offers to send
   * you elsewhere on every page of a service you are already signed into is
   * nagging rather than helping. Claude only needs this on its sign-in route.
   */
  readonly pathPrefix?: string
  readonly reason: string
}

const HINTS: readonly HandoffHint[] = [
  // No blanket hint for `accounts.google.com`.
  //
  // It used to say Google refuses sign-in from Slash, and that was measured to
  // be **false** for the ordinary OAuth redirect: Slash's user agent carries no
  // `Electron` token, and `SLASH_GOOGLE_UA_PROBE` loads Google's real sign-in
  // form here with `blocked: false`. The notice was not only wrong, it was
  // harmful — it pushed people to finish a sign-in in a different browser than
  // they started it in, which loses the flow state and strands them on the
  // provider's fallback address.
  //
  // What genuinely does not work is **FedCM**, and that is a property of
  // specific sites rather than of Google's domain, so it is listed per-site
  // below.
  {
    host: 'claude.ai',
    pathPrefix: '/login',
    reason:
      'Signing in with Google here uses FedCM, a browser feature Electron does not implement, so the ' +
      'account chooser never appears. Signing in with your email works normally in Slash — or use ' +
      'your default browser for this step.'
  },
  {
    host: 'accounts.youtube.com',
    reason:
      'This is Google sign-in, which only runs in browsers Google has approved. Use your default browser for this step.'
  }
]

/** The hint for a URL, if this is a site known to reject us. */
export function handoffHintFor(url: string): HandoffHint | null {
  let host: string
  try {
    host = new URL(url).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    path = '/'
  }

  return (
    HINTS.find((hint) => {
      const hostMatches = host === hint.host || host.endsWith(`.${hint.host}`)
      if (!hostMatches) return false
      return hint.pathPrefix === undefined || path.startsWith(hint.pathPrefix)
    }) ?? null
  )
}
