import { describe, expect, it } from 'vitest'
import { packagesToRemove } from './prunePackages'

const downloaded = [
  'Slash-0.2.3-x64.exe',
  'Slash-0.2.4-x64.exe',
  'Slash-0.2.5-x64.exe',
  'Slash-0.2.6-x64.exe'
]

describe('what it clears', () => {
  it('removes every package except the one still needed', () => {
    // The measured case: 673 MB of installers, four of them, all but the
    // newest already run.
    expect(packagesToRemove(downloaded, 'Slash-0.2.6-x64.exe')).toEqual([
      'Slash-0.2.3-x64.exe',
      'Slash-0.2.4-x64.exe',
      'Slash-0.2.5-x64.exe'
    ])
  })

  it('removes all of them when nothing is pending', () => {
    expect(packagesToRemove(downloaded, null)).toEqual(downloaded)
  })

  it('leaves an empty folder alone', () => {
    expect(packagesToRemove([], null)).toEqual([])
  })
})

describe('what it must never touch', () => {
  it('never removes the package about to be installed', () => {
    // Getting this wrong deletes the file the browser is seconds from running.
    for (const keep of downloaded) {
      expect(packagesToRemove(downloaded, keep)).not.toContain(keep)
    }
  })

  it('leaves files it does not recognise', () => {
    // A cleanup routine that deletes what it does not understand is one
    // nobody should ship: this folder is inside the user's profile.
    const mixed = [...downloaded, 'notes.txt', 'something-else.exe', 'latest.json']
    const removed = packagesToRemove(mixed, null)

    expect(removed).not.toContain('notes.txt')
    expect(removed).not.toContain('something-else.exe')
    expect(removed).not.toContain('latest.json')
    expect(removed).toEqual(downloaded)
  })

  it('matches the name exactly rather than by prefix', () => {
    const tricky = ['Slash-0.2.6-x64.exe', 'Slash-0.2.6-x64.exe.part']
    // The partial is not an .exe, so it is not this function's business.
    expect(packagesToRemove(tricky, 'Slash-0.2.6-x64.exe')).toEqual([])
  })
})
