import { describe, expect, it } from 'vitest'
import type { EngineDownload, ServerCapabilities } from '@shared/types/downloadEngine'
import { BATCH_LIMITS, expandBatch } from './batchUrls'
import { CATEGORY_FOLDERS, folderForCategory } from './categoryFolders'
import { COMPLETION_GRACE_MS, isDisruptive, shouldFire } from './completionAction'
import { refreshVerdict } from './linkRefresh'

describe('expandBatch', () => {
  it('expands a numeric range', () => {
    const { urls } = expandBatch('https://host/file[1-5].jpg')
    expect(urls).toEqual([
      'https://host/file1.jpg',
      'https://host/file2.jpg',
      'https://host/file3.jpg',
      'https://host/file4.jpg',
      'https://host/file5.jpg'
    ])
  })

  it('keeps the zero-padding the pattern asked for', () => {
    // A server with page01.jpg does not have page1.jpg, so the width the user
    // typed is information, not formatting.
    expect(expandBatch('p[01-03].jpg').urls).toEqual(['p01.jpg', 'p02.jpg', 'p03.jpg'])
    expect(expandBatch('p[1-3].jpg').urls).toEqual(['p1.jpg', 'p2.jpg', 'p3.jpg'])
  })

  it('takes the width from the first bound', () => {
    expect(expandBatch('p[001-3].jpg').urls).toEqual(['p001.jpg', 'p002.jpg', 'p003.jpg'])
  })

  it('counts down when the range descends, rather than refusing', () => {
    // Somebody who writes [3-1] wants newest first. That is a preference.
    expect(expandBatch('p[3-1].jpg').urls).toEqual(['p3.jpg', 'p2.jpg', 'p1.jpg'])
  })

  it('expands letters', () => {
    expect(expandBatch('part-[a-d].zip').urls).toEqual([
      'part-a.zip',
      'part-b.zip',
      'part-c.zip',
      'part-d.zip'
    ])
  })

  it('expands two ranges as a product', () => {
    const { urls } = expandBatch('s[1-2]/e[1-3].mkv')
    expect(urls).toEqual([
      's1/e1.mkv',
      's1/e2.mkv',
      's1/e3.mkv',
      's2/e1.mkv',
      's2/e2.mkv',
      's2/e3.mkv'
    ])
  })

  it('passes an ordinary address through as a single download', () => {
    const result = expandBatch('https://host/one.zip')
    expect(result.urls).toEqual(['https://host/one.zip'])
    expect(result.error).toBe(false)
  })

  it('refuses a range that would make thousands of requests', () => {
    // Three keystrokes separate [1-50] from [1-500000], and the target is
    // somebody else's server.
    const result = expandBatch(`f[1-${BATCH_LIMITS.maxUrls + 50}].jpg`)
    expect(result.error).toBe(true)
    expect(result.urls).toEqual([])
    expect(result.note).toContain('Narrow the range')
  })

  it('refuses more ranges than a real pattern has', () => {
    expect(expandBatch('[1-2][1-2][1-2]x').error).toBe(true)
  })

  it('refuses an empty pattern', () => {
    expect(expandBatch('   ').error).toBe(true)
  })

  it('says what it is about to do, for a dialog to show before anything is fetched', () => {
    expect(expandBatch('f[1-9].jpg').note).toBe('9 downloads, from f1.jpg to f9.jpg.')
  })
})

describe('folderForCategory', () => {
  it('returns the base folder untouched when sorting is off', () => {
    expect(folderForCategory('D:/Downloads', 'video', false)).toBe('D:/Downloads')
  })

  it('sorts each kind into its own folder', () => {
    expect(folderForCategory('D:/Downloads', 'video', true)).toContain(CATEGORY_FOLDERS.video)
    expect(folderForCategory('D:/Downloads', 'audio', true)).toContain(CATEGORY_FOLDERS.audio)
  })

  it('leaves "other" at the top level even when sorting is on', () => {
    // A folder called Other slowly collects everything unrecognised, where
    // nobody looks. Unsorted files stay visible instead.
    expect(folderForCategory('D:/Downloads', 'other', true)).toBe('D:/Downloads')
  })
})

describe('shouldFire', () => {
  const download = (state: EngineDownload['state']): EngineDownload =>
    ({ state }) as EngineDownload

  it('does not fire on an empty queue', () => {
    expect(shouldFire([]).fire).toBe(false)
  })

  it('does not fire while something is still running', () => {
    expect(shouldFire([download('completed'), download('downloading')]).fire).toBe(false)
  })

  it('does not fire while something is still probing', () => {
    expect(shouldFire([download('completed'), download('probing')]).fire).toBe(false)
  })

  it('does not fire while something is queued for later', () => {
    // A scheduled start is a queued download with a `startAfter`, not a state
    // of its own.
    expect(shouldFire([download('completed'), download('queued')]).fire).toBe(false)
  })

  it('does not fire when something is paused', () => {
    // A paused transfer is one somebody intends to continue. Shutting the
    // machine down under it is the opposite of what they asked for.
    const verdict = shouldFire([download('completed'), download('paused')])
    expect(verdict.fire).toBe(false)
    expect(verdict.reason).toContain('meant to be continued')
  })

  it('does not fire when something failed', () => {
    const verdict = shouldFire([download('completed'), download('failed')])
    expect(verdict.fire).toBe(false)
    expect(verdict.reason).toContain('did not finish')
  })

  it('does not fire when nothing actually completed', () => {
    expect(shouldFire([download('cancelled')]).fire).toBe(false)
  })

  it('fires once everything finished', () => {
    expect(shouldFire([download('completed'), download('completed')]).fire).toBe(true)
  })

  it('gives a countdown to everything that ends the session', () => {
    expect(isDisruptive('shutdown')).toBe(true)
    expect(isDisruptive('sleep')).toBe(true)
    expect(isDisruptive('quit')).toBe(true)
    expect(isDisruptive('notify')).toBe(false)
    expect(isDisruptive('nothing')).toBe(false)
    expect(COMPLETION_GRACE_MS).toBeGreaterThanOrEqual(15_000)
  })
})

describe('refreshVerdict', () => {
  const caps = (over: Partial<ServerCapabilities> = {}): ServerCapabilities => ({
    totalBytes: 1000,
    acceptsRanges: true,
    suggestedName: null,
    mimeType: 'video/mp4',
    etag: '"abc"',
    lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    ...over
  })

  it('keeps the partial when the ETag still matches', () => {
    const verdict = refreshVerdict(caps(), caps())
    expect(verdict.continueFromPartial).toBe(true)
    expect(verdict.usable).toBe(true)
  })

  it('keeps the partial on a matching modification date when there is no ETag', () => {
    const verdict = refreshVerdict(caps({ etag: null }), caps({ etag: null }))
    expect(verdict.continueFromPartial).toBe(true)
  })

  it('starts again when the size differs — that is a different file', () => {
    const verdict = refreshVerdict(caps(), caps({ totalBytes: 2000 }))
    expect(verdict.continueFromPartial).toBe(false)
    expect(verdict.usable).toBe(true)
    expect(verdict.reason).toContain('different file')
  })

  it('never continues a partial on a matching byte count alone', () => {
    // The whole risk of this feature. Same length is not the same file, and
    // splicing two different videos produces something that plays and is wrong.
    const verdict = refreshVerdict(
      caps({ etag: null, lastModified: null }),
      caps({ etag: null, lastModified: null })
    )
    expect(verdict.continueFromPartial).toBe(false)
    expect(verdict.usable).toBe(true)
    expect(verdict.reason).toContain('starts again')
  })

  it('does not continue when the new address cannot serve ranges', () => {
    expect(refreshVerdict(caps(), caps({ acceptsRanges: false })).continueFromPartial).toBe(false)
  })

  it('refuses an address that did not answer with a file', () => {
    const verdict = refreshVerdict(caps(), caps({ acceptsRanges: false, totalBytes: null }))
    expect(verdict.usable).toBe(false)
  })
})
