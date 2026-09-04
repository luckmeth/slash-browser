/**
 * What Slash Operations stores, and the rules for changing it.
 *
 * Kept apart from main.js so it can be tested without Electron. These are
 * small rules with sharp edges: a blank field means "keep what is stored" for
 * the two secrets and "turn delivery off" for the From address, and getting
 * that backwards either throws away a key somebody just pasted or goes on
 * sending mail they meant to stop. Nothing here touches the filesystem, the
 * network or the clock.
 */

/** Both formats Supabase issues for a service_role key. */
const SERVICE_KEY_SHAPE = /^(eyJ|sb_secret_)/
const RESEND_KEY_SHAPE = /^re_/

/**
 * Whether a string could be sent from: either a bare address, or the display
 * form Resend accepts, `Name <name@example.com>`.
 *
 * Written with string operations rather than a pattern on purpose. A regex
 * literal here has to survive being written to disk by whatever tooling edits
 * this file, and a mangled escape turns `[^\s]` into "any character except
 * the letter s" -- which is a check that passes on nonsense and fails on real
 * addresses, with nothing to see in the diff. It happened once already; see
 * the heredoc row in ../../CLAUDE.md.
 *
 * Deliberately loose either way. The authority on whether an address works is
 * Resend, and its answer arrives in the email log.
 */
function looksLikeAddress(value) {
  const bracketed = value.endsWith('>') && value.includes('<')
  const inner = bracketed ? value.slice(value.indexOf('<') + 1, -1).trim() : value

  if (!inner || inner.includes('<') || inner.includes('>')) return false
  // A whitespace character is one that trims away to nothing; no pattern needed.
  if ([...inner].some((character) => character.trim() === '')) return false

  const at = inner.indexOf('@')
  if (at < 1 || inner.indexOf('@', at + 1) !== -1) return false

  const domain = inner.slice(at + 1)
  const dot = domain.indexOf('.')
  return dot > 0 && dot < domain.length - 1
}

const EMPTY = { serviceKey: '', resendApiKey: '', emailFrom: '' }

/**
 * Reads the decrypted credentials file.
 *
 * It held nothing but the service-role key until email delivery became
 * configurable here, so a record written by an earlier version is a bare key
 * string rather than JSON. It is read as one instead of being discarded: an
 * operator who updates the app must not be asked for the key again.
 */
function parseCredentials(plain) {
  const text = String(plain ?? '')
  try {
    const record = JSON.parse(text)
    if (record && typeof record === 'object' && typeof record.serviceKey === 'string') {
      return {
        serviceKey: record.serviceKey,
        resendApiKey: typeof record.resendApiKey === 'string' ? record.resendApiKey : '',
        emailFrom: typeof record.emailFrom === 'string' ? record.emailFrom : ''
      }
    }
  } catch {
    /* the old format is a bare key, which is not valid JSON */
  }
  return { ...EMPTY, serviceKey: text }
}

function serialiseCredentials(record) {
  return JSON.stringify({
    serviceKey: record.serviceKey,
    resendApiKey: record.resendApiKey || '',
    emailFrom: record.emailFrom || ''
  })
}

/** Whether transactional email can be sent — the same test the server makes of its environment. */
function emailConfigured(record) {
  return Boolean(record && record.resendApiKey && record.emailFrom)
}

/**
 * What the setup screen may report to its renderer.
 *
 * Never a secret. The window that shows this page navigates to the embedded
 * server the moment it starts, and a value handed to a renderer is a value in
 * a process that then loads pages — so what comes back is whether a key
 * exists, not what it is. The From address is not a secret and round-trips, so
 * clearing it is something an operator can actually do.
 */
function describeCredentials(record) {
  return {
    hasServiceKey: Boolean(record && record.serviceKey),
    hasResendKey: Boolean(record && record.resendApiKey),
    emailFrom: (record && record.emailFrom) || ''
  }
}

const trim = (value) => String(value ?? '').trim()

/**
 * Decides what to store from what was typed, or refuses with a reason.
 *
 * `stored` is the current record, or null on first run. The rules, all of
 * which the screen states:
 *
 * - A blank secret keeps the stored one. There is no way to display a secret
 *   back into a field, so blank cannot mean "erase".
 * - Clearing the From address turns delivery off, and deletes the stored
 *   Resend key with it. Off means the secret is gone, not dormant.
 * - A key with no From address, or a From address with no key, is refused.
 *   Both are needed to send, so half of the pair is a screen that reports
 *   success and an email log that fills with failures.
 */
function checkSetup(fields, stored) {
  const input = typeof fields === 'string' ? { key: fields } : (fields ?? {})
  const current = stored ?? null

  const typedKey = trim(input.key)
  const serviceKey = typedKey || (current ? current.serviceKey : '')
  if (!serviceKey) {
    return { ok: false, problem: 'Paste the service_role key from Supabase → Project Settings → API.' }
  }
  if (typedKey && !SERVICE_KEY_SHAPE.test(typedKey)) {
    return { ok: false, problem: 'That does not look like a service_role key.' }
  }

  const typedResend = trim(input.resendApiKey)
  const emailFrom = trim(input.emailFrom)

  if (!emailFrom) {
    if (typedResend) {
      return {
        ok: false,
        problem: 'A Resend key needs a From address as well — nothing can be sent without both.'
      }
    }
    // Delivery off, and the stored key goes with it.
    return { ok: true, credentials: { serviceKey, resendApiKey: '', emailFrom: '' } }
  }

  if (!looksLikeAddress(emailFrom)) {
    return { ok: false, problem: 'The From address needs to be an email address, or Name <name@example.com>.' }
  }
  if (typedResend && !RESEND_KEY_SHAPE.test(typedResend)) {
    return { ok: false, problem: 'A Resend API key starts with "re_".' }
  }

  const resendApiKey = typedResend || (current ? current.resendApiKey : '')
  if (!resendApiKey) {
    return {
      ok: false,
      problem: 'Add a Resend API key, or clear the From address to leave email delivery off.'
    }
  }

  return { ok: true, credentials: { serviceKey, resendApiKey, emailFrom } }
}

module.exports = {
  parseCredentials,
  serialiseCredentials,
  describeCredentials,
  emailConfigured,
  checkSetup
}
