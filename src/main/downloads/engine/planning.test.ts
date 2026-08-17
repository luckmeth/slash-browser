import { describe, it, expect } from 'vitest'
import { MIN_SEGMENT_BYTES } from '@shared/types/downloadEngine'
import {
  categorise,
  estimateSecondsRemaining,
  filenameFromDisposition,
  planConnections,
  planSegments,
  readCapabilities,
  resumeIsSafe,
  retryDelayMs,
  safeFilename
} from './planning'

const caps = (over: Partial<ReturnType<typeof readCapabilities>> = {}) => ({
  totalBytes: 100 * 1024 * 1024,
  acceptsRanges: true,
  suggestedName: null,
  mimeType: null,
  etag: '"abc"',
  lastModified: null,
  ...over
})

describe('readCapabilities', () => {
  it('reads size and range support', () => {
    const result = readCapabilities({ 'content-length': '2048', 'accept-ranges': 'bytes' }, 200)
    expect(result.totalBytes).toBe(2048)
    expect(result.acceptsRanges).toBe(true)
  })

  it('treats a 206 as proof of range support', () => {
    // The server just served a range; the header is then redundant.
    expect(readCapabilities({}, 206).acceptsRanges).toBe(true)
  })

  it('treats "none" and a missing header as no support', () => {
    expect(readCapabilities({ 'accept-ranges': 'none' }, 200).acceptsRanges).toBe(false)
    expect(readCapabilities({}, 200).acceptsRanges).toBe(false)
  })

  it('is case-insensitive and handles array header values', () => {
    const result = readCapabilities({ 'Content-Length': ['4096'], 'Accept-Ranges': 'bytes' }, 200)
    expect(result.totalBytes).toBe(4096)
    expect(result.acceptsRanges).toBe(true)
  })

  it('reports an unknown size rather than guessing zero', () => {
    // Zero would make the file look complete before a byte arrived.
    expect(readCapabilities({}, 200).totalBytes).toBeNull()
    expect(readCapabilities({ 'content-length': 'banana' }, 200).totalBytes).toBeNull()
  })

  it('strips parameters off the content type', () => {
    expect(readCapabilities({ 'content-type': 'text/html; charset=utf-8' }, 200).mimeType).toBe(
      'text/html'
    )
  })
})

describe('filenameFromDisposition', () => {
  it('reads a quoted filename', () => {
    expect(filenameFromDisposition('attachment; filename="report.pdf"')).toBe('report.pdf')
  })

  it('reads an unquoted filename', () => {
    expect(filenameFromDisposition('attachment; filename=report.pdf')).toBe('report.pdf')
  })

  it('prefers the RFC 5987 form for non-ASCII names', () => {
    expect(
      filenameFromDisposition("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
    ).toBe('résumé.pdf')
  })

  it('returns null when there is no filename', () => {
    expect(filenameFromDisposition('inline')).toBeNull()
    expect(filenameFromDisposition(null)).toBeNull()
  })

  it('refuses to let a server escape the download directory', () => {
    // This header is attacker-controlled and becomes a filesystem path.
    expect(filenameFromDisposition('attachment; filename="../../../etc/passwd"')).toBe('passwd')
    expect(filenameFromDisposition('attachment; filename="..\\\\..\\\\windows\\\\system32\\\\evil.dll"')).toBe(
      'evil.dll'
    )
  })
})

describe('safeFilename', () => {
  it('keeps ordinary names intact', () => {
    expect(safeFilename('Slash-0.1.0-x64.exe')).toBe('Slash-0.1.0-x64.exe')
  })

  it('strips path separators and traversal', () => {
    expect(safeFilename('../../secret.txt')).toBe('secret.txt')
    expect(safeFilename('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts')
  })

  it('removes characters Windows refuses', () => {
    expect(safeFilename('a<b>c:d"e|f?g*h.txt')).toBe('abcdefgh.txt')
  })

  it('never returns an empty name', () => {
    expect(safeFilename('')).toBe('download')
    expect(safeFilename('...')).toBe('download')
    expect(safeFilename('///')).toBe('download')
  })

  it('escapes Windows reserved device names', () => {
    // Writing to CON or NUL does not create a file; it talks to a device.
    expect(safeFilename('CON')).toBe('download-CON')
    expect(safeFilename('nul.txt')).toBe('download-nul.txt')
  })
})

describe('planConnections', () => {
  it('splits a large file when the server supports ranges', () => {
    const plan = planConnections(caps(), 8)
    expect(plan.connections).toBe(8)
    expect(plan.note).toContain('8 connections')
  })

  it('refuses to split without range support, and says why', () => {
    const plan = planConnections(caps({ acceptsRanges: false }), 8)
    expect(plan.connections).toBe(1)
    // The reason matters: it is the server's limitation, not a broken feature.
    expect(plan.note).toContain('does not support range requests')
  })

  it('refuses to split when the size is unknown', () => {
    // Segments cannot be planned without knowing where the end is.
    expect(planConnections(caps({ totalBytes: null }), 8).connections).toBe(1)
  })

  it('does not split a small file', () => {
    const plan = planConnections(caps({ totalBytes: 500 * 1024 }), 8)
    expect(plan.connections).toBe(1)
    expect(plan.note).toContain('cost more than they save')
  })

  it('never makes a segment smaller than the floor', () => {
    // 5 MB with a 2 MB floor affords two segments, not eight.
    const plan = planConnections(caps({ totalBytes: 5 * MIN_SEGMENT_BYTES / 2 }), 8)
    expect(plan.connections).toBeLessThanOrEqual(2)
  })

  it('explains a single connection by the reason that actually applies', () => {
    // Asking for one and being told "the file is too small" is a true statement
    // about the wrong thing, and reads as the setting having been ignored.
    expect(planConnections(caps(), 1).note).toBe('One connection, as configured.')
    expect(planConnections(caps({ totalBytes: 500 * 1024 }), 4).note).toContain(
      'cost more than they save'
    )
  })

  it('clamps to the hard ceiling', () => {
    expect(planConnections(caps({ totalBytes: 10_000 * 1024 * 1024 }), 999).connections).toBe(8)
    expect(planConnections(caps(), 0).connections).toBeGreaterThanOrEqual(1)
  })
})

describe('planSegments', () => {
  it('covers every byte exactly once', () => {
    const segments = planSegments(1000, 4)
    expect(segments[0]).toMatchObject({ start: 0, end: 249 })
    for (let i = 1; i < segments.length; i++) {
      // No gaps and no overlaps — either would corrupt the reassembled file.
      expect(segments[i]!.start).toBe(segments[i - 1]!.end + 1)
    }
    expect(segments.at(-1)!.end).toBe(999)
  })

  it('gives the remainder to the last segment', () => {
    const segments = planSegments(1003, 4)
    expect(segments.at(-1)!.end).toBe(1002)
    const covered = segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0)
    expect(covered).toBe(1003)
  })

  it('handles a single segment and an empty file', () => {
    expect(planSegments(500, 1)).toEqual([{ index: 0, start: 0, end: 499, receivedBytes: 0 }])
    expect(planSegments(0, 4)).toEqual([])
  })
})

describe('resumeIsSafe', () => {
  it('resumes when a strong ETag still matches', () => {
    expect(resumeIsSafe(caps(), caps()).safe).toBe(true)
  })

  it('refuses when the ETag changed', () => {
    // Splicing two versions together produces a corrupt file that looks complete.
    expect(resumeIsSafe(caps(), caps({ etag: '"different"' })).safe).toBe(false)
  })

  it('refuses a weak validator', () => {
    // W/ promises semantic equivalence, not identical bytes.
    const result = resumeIsSafe(caps({ etag: 'W/"abc"' }), caps({ etag: 'W/"abc"' }))
    expect(result.safe).toBe(false)
    expect(result.reason).toContain('weak validator')
  })

  it('falls back to Last-Modified when there is no ETag', () => {
    const before = caps({ etag: null, lastModified: 'Wed, 21 Oct 2020 07:28:00 GMT' })
    expect(resumeIsSafe(before, before).safe).toBe(true)
    expect(resumeIsSafe(before, caps({ etag: null, lastModified: 'Thu, 22 Oct 2020 07:28:00 GMT' })).safe).toBe(
      false
    )
  })

  it('refuses when there is no validator at all', () => {
    const bare = caps({ etag: null, lastModified: null })
    const result = resumeIsSafe(bare, bare)
    expect(result.safe).toBe(false)
    expect(result.reason).toContain('no way to tell')
  })

  it('refuses when the size changed or ranges disappeared', () => {
    expect(resumeIsSafe(caps(), caps({ totalBytes: 999 })).safe).toBe(false)
    expect(resumeIsSafe(caps(), caps({ acceptsRanges: false })).safe).toBe(false)
  })
})

describe('retryDelayMs', () => {
  it('backs off exponentially and then stops growing', () => {
    expect(retryDelayMs(1)).toBe(1000)
    expect(retryDelayMs(2)).toBe(2000)
    expect(retryDelayMs(3)).toBe(4000)
    // Hammering a struggling server is how a retry policy becomes the problem.
    expect(retryDelayMs(20)).toBe(30_000)
  })
})

describe('categorise', () => {
  it('uses the extension first', () => {
    expect(categorise('film.mkv', null)).toBe('video')
    expect(categorise('setup.exe', null)).toBe('software')
    expect(categorise('backup.tar.gz', null)).toBe('archive')
    expect(categorise('paper.pdf', null)).toBe('document')
  })

  it('falls back to the MIME type', () => {
    expect(categorise('file', 'video/mp4')).toBe('video')
    expect(categorise('file', 'application/pdf')).toBe('document')
  })

  it('prefers the extension when the server says octet-stream', () => {
    // Servers send application/octet-stream for everything, so the filename is
    // usually the better signal despite being less trustworthy.
    expect(categorise('holiday.mp4', 'application/octet-stream')).toBe('video')
  })

  it('falls back to other', () => {
    expect(categorise('mystery', null)).toBe('other')
  })
})

describe('estimateSecondsRemaining', () => {
  it('divides what is left by the current rate', () => {
    expect(estimateSecondsRemaining(1000, 200, 100)).toBe(8)
  })

  it('returns null rather than a fake estimate', () => {
    // No total and no rate both mean "unknown"; inventing a number would be worse.
    expect(estimateSecondsRemaining(null, 200, 100)).toBeNull()
    expect(estimateSecondsRemaining(1000, 200, 0)).toBeNull()
  })

  it('never goes negative once complete', () => {
    expect(estimateSecondsRemaining(1000, 1000, 100)).toBe(0)
    expect(estimateSecondsRemaining(1000, 1200, 100)).toBe(0)
  })
})
