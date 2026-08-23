import { describe, it, expect } from 'vitest'
import { EXTRACT_SCRIPT } from './PageMediaExtractor'

/**
 * The script that runs in the page's own world.
 *
 * Tested because it is a **string**, so nothing else checks it. A syntax error
 * or a typo'd property name does not fail the build, does not fail typecheck,
 * and does not throw where anybody sees it — `extract` catches and returns null,
 * and the feature silently reports "nothing to download" for ever. That is the
 * exact shape of the two failures this downloader has already had.
 *
 * Run here against stand-ins for the globals YouTube provides.
 */
function runScript(globals: { player?: unknown; initial?: unknown; title?: string }): unknown {
  const document = {
    title: globals.title ?? 'Document title',
    querySelector: (selector: string) => (selector === '#movie_player' ? globals.player ?? null : null)
  }
  const win = { ytInitialPlayerResponse: globals.initial ?? null }

  // Evaluated the same way Electron evaluates it: as an expression.
  return new Function('document', 'window', `return ${EXTRACT_SCRIPT}`)(document, win)
}

const streamingData = {
  formats: [{ url: 'https://x.test/a', mimeType: 'video/mp4; codecs="avc1, mp4a"' }],
  adaptiveFormats: [{ url: 'https://x.test/b', mimeType: 'video/mp4; codecs="avc1"' }]
}

describe('EXTRACT_SCRIPT', () => {
  it('is valid JavaScript', () => {
    // The check that would have caught a mangled template literal.
    expect(() => new Function(`return ${EXTRACT_SCRIPT}`)).not.toThrow()
  })

  it('reads the player response when the player exposes one', () => {
    const result = runScript({
      player: {
        getPlayerResponse: () => ({ streamingData, videoDetails: { title: 'A song' } })
      }
    }) as { title: string; streamingData: typeof streamingData }

    expect(result.title).toBe('A song')
    expect(result.streamingData.formats).toHaveLength(1)
    expect(result.streamingData.adaptiveFormats).toHaveLength(1)
  })

  it('prefers the player over the page global, which goes stale', () => {
    // YouTube navigates without loading a document, so ytInitialPlayerResponse
    // can describe the video you were watching a minute ago.
    const result = runScript({
      player: { getPlayerResponse: () => ({ streamingData, videoDetails: { title: 'Current' } }) },
      initial: { streamingData: { formats: [] }, videoDetails: { title: 'Stale' } }
    }) as { title: string }

    expect(result.title).toBe('Current')
  })

  it('falls back to the page global when there is no player yet', () => {
    const result = runScript({
      initial: { streamingData, videoDetails: { title: 'From the page' } }
    }) as { title: string }

    expect(result.title).toBe('From the page')
  })

  it('falls back to the document title when the details have none', () => {
    const result = runScript({
      initial: { streamingData },
      title: 'Tab title'
    }) as { title: string }

    expect(result.title).toBe('Tab title')
  })

  it('returns null rather than throwing when there is no player response', () => {
    expect(runScript({})).toBeNull()
    expect(runScript({ initial: {} })).toBeNull()
  })

  it('survives a player that throws', () => {
    // It is somebody else's object on somebody else's page.
    const result = runScript({
      player: {
        getPlayerResponse: () => {
          throw new Error('nope')
        }
      }
    })
    expect(result).toBeNull()
  })

  it('normalises missing format arrays rather than passing undefined on', () => {
    const result = runScript({ initial: { streamingData: {} } }) as {
      streamingData: { formats: unknown[]; adaptiveFormats: unknown[] }
    }
    expect(result.streamingData.formats).toEqual([])
    expect(result.streamingData.adaptiveFormats).toEqual([])
  })
})
