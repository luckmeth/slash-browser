import { describe, expect, it } from 'vitest'
import { checksumFor, chooseAsset, isOfficialDownload, YTDLP_RELEASE_API, shouldRefreshYtDlp, YTDLP_REFRESH_INTERVAL_MS } from './ytDlpRelease'

const OFFICIAL = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe'
const SUMS = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-512SUMS'

const release = (over: Record<string, unknown> = {}): unknown => ({
  tag_name: '2026.08.19',
  assets: [
    { name: 'yt-dlp.exe', browser_download_url: OFFICIAL, size: 17_840_399 },
    { name: 'SHA2-512SUMS', browser_download_url: SUMS, size: 4096 },
    { name: 'yt-dlp', browser_download_url: OFFICIAL.replace('.exe', ''), size: 3_000_000 }
  ],
  ...over
})

describe('isOfficialDownload', () => {
  it('accepts a release download from the repository', () => {
    expect(isOfficialDownload(OFFICIAL)).toBe(true)
  })

  it('refuses a lookalike host', () => {
    // The trick this exists for: the official prefix appearing inside a longer
    // hostname. A `startsWith` on the whole URL would let this through.
    expect(isOfficialDownload('https://github.com.evil.test/yt-dlp/yt-dlp/releases/download/x/yt-dlp.exe')).toBe(false)
    expect(isOfficialDownload('https://evil.test/github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp.exe')).toBe(false)
  })

  it('refuses another repository on the same host', () => {
    expect(isOfficialDownload('https://github.com/someone/else/releases/download/x/yt-dlp.exe')).toBe(false)
  })

  it('refuses a path that is not a release download', () => {
    expect(isOfficialDownload('https://github.com/yt-dlp/yt-dlp/raw/master/yt-dlp.exe')).toBe(false)
  })

  it('refuses plain http', () => {
    expect(isOfficialDownload(OFFICIAL.replace('https:', 'http:'))).toBe(false)
  })

  it('refuses rubbish', () => {
    expect(isOfficialDownload('')).toBe(false)
    expect(isOfficialDownload('not a url')).toBe(false)
    expect(isOfficialDownload('file:///C:/evil.exe')).toBe(false)
  })
})

describe('chooseAsset', () => {
  it('picks the Windows binary and its checksum file', () => {
    const choice = chooseAsset(release())
    expect(choice).toEqual({
      version: '2026.08.19',
      url: OFFICIAL,
      checksumUrl: SUMS,
      sizeBytes: 17_840_399
    })
  })

  it('refuses an asset pointing somewhere other than the repository', () => {
    // The response is fetched from a pinned API URL, but the URLs *inside* it
    // are still untrusted — this is the file that gets executed.
    const hostile = release({
      assets: [
        {
          name: 'yt-dlp.exe',
          browser_download_url: 'https://evil.test/yt-dlp.exe',
          size: 17_000_000
        }
      ]
    })
    expect(chooseAsset(hostile)).toEqual({
      error: 'That release has no yt-dlp.exe from the official repository.'
    })
  })

  it('refuses an implausible size', () => {
    // A 200-byte "binary" is a redirect page or an error, and a 500 MB one is
    // not yt-dlp.
    expect(chooseAsset(release({ assets: [{ name: 'yt-dlp.exe', browser_download_url: OFFICIAL, size: 200 }] })))
      .toHaveProperty('error')
    expect(
      chooseAsset(release({ assets: [{ name: 'yt-dlp.exe', browser_download_url: OFFICIAL, size: 900_000_000 }] }))
    ).toHaveProperty('error')
  })

  it('reports a missing checksum rather than pretending', () => {
    const choice = chooseAsset(
      release({ assets: [{ name: 'yt-dlp.exe', browser_download_url: OFFICIAL, size: 17_000_000 }] })
    )
    expect(choice).toHaveProperty('checksumUrl', null)
  })

  it('refuses a release with no version', () => {
    expect(chooseAsset(release({ tag_name: undefined }))).toHaveProperty('error')
  })

  it('survives rubbish', () => {
    expect(chooseAsset(null)).toHaveProperty('error')
    expect(chooseAsset('nope')).toHaveProperty('error')
    expect(chooseAsset({ tag_name: 'x', assets: [null, 7, 'z'] })).toHaveProperty('error')
  })

  it('installs only from the official repository', () => {
    expect(YTDLP_RELEASE_API).toBe('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')
  })
})

describe('checksumFor', () => {
  const hex = 'a'.repeat(128)
  const other = 'b'.repeat(128)

  it('finds the sum for the named file', () => {
    expect(checksumFor(`${other}  yt-dlp\n${hex}  yt-dlp.exe\n`)).toBe(hex)
  })

  it('handles the binary-mode asterisk', () => {
    expect(checksumFor(`${hex} *yt-dlp.exe`)).toBe(hex)
  })

  it('returns null when the name is absent', () => {
    // A checksum that silently matched nothing would make verification pass
    // for any bytes at all — the one failure mode that must not be quiet.
    expect(checksumFor(`${other}  something-else\n`)).toBeNull()
  })

  it('does not match a partial name', () => {
    expect(checksumFor(`${hex}  not-yt-dlp.exe\n`)).toBeNull()
  })

  it('ignores a line that is not a sum', () => {
    expect(checksumFor('# a comment\nnot a checksum yt-dlp.exe\n')).toBeNull()
  })
})


describe('shouldRefreshYtDlp', () => {
  const base = {
    enabled: true,
    managed: true,
    lastCheckedAt: 0,
    now: YTDLP_REFRESH_INTERVAL_MS + 1
  }

  it('refreshes a managed copy once the interval has passed', () => {
    expect(shouldRefreshYtDlp(base)).toBe(true)
  })

  it('does nothing when the switch is off', () => {
    expect(shouldRefreshYtDlp({ ...base, enabled: false })).toBe(false)
  })

  it('never touches a yt-dlp the user installed themselves', () => {
    // The clause that matters most. pip, scoop and winget copies belong to the
    // user and to whatever else on their machine uses them; replacing one would
    // be Slash reaching outside its own directory to change other software.
    expect(shouldRefreshYtDlp({ ...base, managed: false })).toBe(false)
    // Not even when it is years old.
    expect(
      shouldRefreshYtDlp({ ...base, managed: false, now: YTDLP_REFRESH_INTERVAL_MS * 100 })
    ).toBe(false)
  })

  it('waits out the interval rather than checking on every launch', () => {
    expect(shouldRefreshYtDlp({ ...base, now: 1 })).toBe(false)
    expect(shouldRefreshYtDlp({ ...base, now: YTDLP_REFRESH_INTERVAL_MS - 1 })).toBe(false)
  })

  it('refreshes exactly on the boundary', () => {
    expect(shouldRefreshYtDlp({ ...base, now: YTDLP_REFRESH_INTERVAL_MS })).toBe(true)
  })

  it('treats a backwards clock as due rather than as never due', () => {
    // A corrected system clock or a restored machine leaves a future
    // `lastCheckedAt`. Reading that as "not yet" would mean a copy that can
    // never update again.
    expect(shouldRefreshYtDlp({ ...base, lastCheckedAt: 10_000, now: 5_000 })).toBe(true)
  })

  it('checks a fortnight, from the release cadence rather than a round number', () => {
    expect(YTDLP_REFRESH_INTERVAL_MS).toBe(14 * 24 * 60 * 60 * 1000)
  })
})
