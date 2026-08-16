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
  readonly reason: string
}

const HINTS: readonly HandoffHint[] = [
  {
    host: 'accounts.google.com',
    reason:
      'Google only allows sign-in from browsers it has approved, and Slash is not on that list. Signing in from your default browser works, and Slash keeps everything else.'
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
  return HINTS.find((hint) => host === hint.host || host.endsWith(`.${hint.host}`)) ?? null
}
