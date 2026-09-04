import { describe, expect, it } from 'vitest'
import {
  backoffMs,
  cancellableDelay,
  classifyFailure,
  MAX_BACKOFF_MS,
  parseRetryAfter
} from './retryPolicy'
import { confinedPath, isUsableDirectory, MAX_FILENAME_LENGTH, sanitiseFilename } from './paths'
import { limitMessage, MEDIA_LIMITS, withinLimit } from './limits'

const withStatus = (status: number, message = `Server returned ${status}`): Error => {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}

describe('classifyFailure — permanent', () => {
  it.each([400, 401, 403, 404, 405, 410])('does not retry %i', (status) => {
    // A file that is not there will still not be there in eight seconds, and
    // four attempts at an authorization failure is how an account gets
    // rate-limited.
    const verdict = classifyFailure(withStatus(status))
    expect(verdict.kind).toBe('permanent')
    expect(verdict.retryable).toBe(false)
  })

  it('does not retry an unlisted 4xx either', () => {
    expect(classifyFailure(withStatus(418)).retryable).toBe(false)
  })

  it('does not retry a refusal this browser made on purpose', () => {
    // Retrying our own decision would look, to the user, like the browser
    // struggling rather than declining.
    expect(classifyFailure(new Error('This stream is encrypted.')).retryable).toBe(false)
    expect(
      classifyFailure(new Error('Live MPEG-DASH streams are not currently supported.')).retryable
    ).toBe(false)
    expect(classifyFailure(new Error('Too many redirects')).retryable).toBe(false)
  })

  it('says why, in words that reach the list', () => {
    expect(classifyFailure(withStatus(403)).reason).toContain('refused')
  })
})

describe('classifyFailure — transient', () => {
  it.each([408, 425, 429, 500, 502, 503, 504])('retries %i', (status) => {
    const verdict = classifyFailure(withStatus(status))
    expect(verdict.kind).toBe('transient')
    expect(verdict.retryable).toBe(true)
  })

  it.each([
    'ECONNRESET',
    'socket hang up',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_TIMED_OUT',
    'net::ERR_INTERNET_DISCONNECTED'
  ])('retries a dropped connection: %s', (message) => {
    expect(classifyFailure(new Error(message)).retryable).toBe(true)
  })

  it('carries the server’s own Retry-After through', () => {
    const verdict = classifyFailure(withStatus(429), { retryAfter: '30' })
    expect(verdict.retryAfterMs).toBe(30_000)
    expect(verdict.reason).toContain('slow down')
  })

  it('retries an unrecognised failure, but knows it is guessing', () => {
    const verdict = classifyFailure(new Error('something odd happened'))
    expect(verdict.kind).toBe('unknown')
    expect(verdict.retryable).toBe(true)
  })
})

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000)
  })

  it('reads an HTTP date as a wait from now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000)
  })

  it('treats a date in the past as no wait rather than a negative one', () => {
    const now = Date.parse('2026-01-01T00:01:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0)
  })

  it('ignores nonsense instead of trusting it', () => {
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
  })
})

describe('backoffMs', () => {
  it('grows exponentially', () => {
    const noJitter = (): number => 1
    expect(backoffMs(1, null, noJitter)).toBe(1000)
    expect(backoffMs(2, null, noJitter)).toBe(2000)
    expect(backoffMs(3, null, noJitter)).toBe(4000)
  })

  it('never waits longer than the cap', () => {
    expect(backoffMs(30, null, () => 1)).toBeLessThanOrEqual(MAX_BACKOFF_MS)
  })

  it('jitters, so downloads that failed together do not retry in lockstep', () => {
    // Several transfers from one host fail at the same instant when a
    // connection drops. Without jitter every retry arrives as a burst, which
    // looks exactly like an attack.
    expect(backoffMs(3, null, () => 0)).not.toBe(backoffMs(3, null, () => 1))
  })

  it('lets the server decide when the server said', () => {
    expect(backoffMs(1, 45_000, () => 1)).toBe(45_000)
  })

  it('still caps a server asking for an absurd wait', () => {
    expect(backoffMs(1, 86_400_000, () => 1)).toBe(MAX_BACKOFF_MS)
  })
})

describe('cancellableDelay', () => {
  it('waits when nothing cancels it', async () => {
    expect(await cancellableDelay(10, () => false)).toBe('elapsed')
  })

  it('stops as soon as it is cancelled, rather than at the end of the wait', async () => {
    // A download cancelled during a sixty-second backoff must stop then — and
    // must not resurrect itself when the timer finally fires.
    expect(await cancellableDelay(60_000, () => true)).toBe('cancelled')
  })
})

describe('sanitiseFilename — the attacker controls this string', () => {
  it.each([
    ['../../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\evil.dll', 'evil.dll'],
    ['/etc/shadow', 'shadow'],
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
    ['C:file.txt', 'file.txt'],
    ['\\\\server\\share\\payload.exe', 'payload.exe']
  ])('reduces %s to a plain name', (input, expected) => {
    expect(sanitiseFilename(input)).toBe(expected)
  })

  it('strips NUL and other control characters', () => {
    expect(sanitiseFilename('report\u0000.pdf')).toBe('report.pdf')
    expect(sanitiseFilename('a\u0007b\u001fc.txt')).toBe('abc.txt')
  })

  it('strips the characters Windows refuses', () => {
    expect(sanitiseFilename('in<>:"|?*valid.txt')).toBe('invalid.txt')
  })

  it('renames a reserved device name rather than failing on it', () => {
    expect(sanitiseFilename('CON')).toBe('download-CON')
    expect(sanitiseFilename('lpt1.txt')).toBe('download-lpt1.txt')
  })

  it('drops trailing dots and spaces, which Windows ignores silently', () => {
    // `evil.exe .` and `evil.exe` are the same file under two names, which is a
    // way to make a download look like something it is not.
    expect(sanitiseFilename('evil.exe .')).toBe('evil.exe')
  })

  it('never returns an empty name', () => {
    // A download that has completed has to be written somewhere.
    expect(sanitiseFilename('')).toBe('download')
    expect(sanitiseFilename('...')).toBe('download')
    expect(sanitiseFilename('/')).toBe('download')
  })

  it('truncates a very long name but keeps the extension', () => {
    // A file that loses its `.mp4` is one the operating system no longer knows
    // how to open.
    const long = `${'a'.repeat(500)}.mp4`
    const safe = sanitiseFilename(long)
    expect(safe.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH)
    expect(safe.endsWith('.mp4')).toBe(true)
  })

  it('leaves an ordinary name alone', () => {
    expect(sanitiseFilename('My Film (2026) [1080p].mkv')).toBe('My Film (2026) [1080p].mkv')
  })
})

describe('confinedPath', () => {
  const root = process.platform === 'win32' ? 'C:\\Users\\me\\Downloads' : '/home/me/Downloads'

  it('puts an ordinary file in the folder', () => {
    const result = confinedPath(root, 'film.mp4')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.startsWith(root)).toBe(true)
    expect(result.path.endsWith('film.mp4')).toBe(true)
  })

  it.each([
    '../../../etc/passwd',
    '..\\..\\evil.exe',
    '/etc/passwd',
    'C:\\Windows\\evil.dll',
    'a/../../b.txt'
  ])('keeps %s inside the folder', (name) => {
    const result = confinedPath(root, name)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.startsWith(root)).toBe(true)
  })

  it('is not fooled by a sibling folder with the same prefix', () => {
    // The reason this compares with a separator appended rather than by prefix:
    // `/home/me/Downloads-evil` starts with `/home/me/Downloads`.
    const result = confinedPath(root, 'x.txt')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.startsWith(`${root}-evil`)).toBe(false)
  })

  it('refuses when there is no folder to write into', () => {
    expect(confinedPath('', 'a.txt').ok).toBe(false)
  })
})

describe('isUsableDirectory', () => {
  it('accepts an absolute path', () => {
    expect(isUsableDirectory(process.platform === 'win32' ? 'C:\\Downloads' : '/downloads')).toBe(true)
  })

  it('refuses a relative one rather than resolving it against the process', () => {
    // Whatever the process considers "current" is not somewhere the user chose.
    expect(isUsableDirectory('downloads')).toBe(false)
    expect(isUsableDirectory('')).toBe(false)
  })
})

describe('limits', () => {
  it('accepts a real stream and refuses an absurd one', () => {
    expect(withinLimit(3_600, 'maxSegments').ok).toBe(true)
    expect(withinLimit(1_000_000, 'maxSegments').ok).toBe(false)
  })

  it('explains itself, because a download that stops silently looks broken', () => {
    const verdict = withinLimit(1_000_000, 'maxSegments')
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toContain('segments')
  })

  it('has a message for every limit', () => {
    for (const name of Object.keys(MEDIA_LIMITS) as (keyof typeof MEDIA_LIMITS)[]) {
      expect(limitMessage(name).length).toBeGreaterThan(20)
    }
  })

  it('bounds a two-hour film comfortably inside the segment cap', () => {
    // The numbers have to be defensible next to each other: two hours of
    // two-second segments is 3,600, so the cap must not be near it.
    expect(MEDIA_LIMITS.maxSegments).toBeGreaterThan(3_600 * 2)
  })
})
