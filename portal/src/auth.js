import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Password handling.
 *
 * `scrypt` from Node's own crypto rather than a dependency: it is deliberately
 * slow, memory-hard, and already here. Comparison is constant-time, because a
 * fast-fail comparison leaks how much of a key was right.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  return { salt, key: scryptSync(password, salt, 64).toString('hex') }
}

export function verifyPassword(password, salt, expectedKey) {
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedKey, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function newSessionToken() {
  return randomBytes(32).toString('hex')
}

/**
 * The signed-in company for a request, or null.
 *
 * Sessions live in the database rather than in a signed cookie so that signing
 * out, or deleting an account, genuinely ends them.
 */
export function currentCompany(db, req) {
  const token = readCookie(req, 'slash_portal')
  if (!token) return null
  return (
    db
      .prepare(
        `SELECT c.* FROM sessions s JOIN companies c ON c.id = s.company_id WHERE s.token = ?`
      )
      .get(token) ?? null
  )
}

function readCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}
