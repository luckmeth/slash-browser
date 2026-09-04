import { describe, it, expect } from 'vitest'
import {
  openTargetFromArgv,
  shouldOfferDefault,
  toFileUrl,

  parseUserChoiceProgId,
  isSlashProgId,
  type PromptState
} from './defaultBrowserRules'

const state = (over: Partial<PromptState> = {}): PromptState => ({
  isDefault: false,
  asks: 0,
  lastAskedAt: 0,
  suppressed: false,
  ...over
})

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)

describe('shouldOfferDefault', () => {
  it('offers on a fresh install', () => {
    expect(shouldOfferDefault(state(), NOW)).toBe(true)
  })

  it('never offers when Slash already is the default', () => {
    // An offer to do something already done reads as a browser that cannot tell.
    expect(shouldOfferDefault(state({ isDefault: true }), NOW)).toBe(false)
  })

  it('stops when somebody says not to ask again', () => {
    expect(shouldOfferDefault(state({ suppressed: true }), NOW)).toBe(false)
  })

  /*
   * These three used to assert the opposite, and the change is deliberate.
   *
   * The old rule offered twice, a fortnight apart, then never again — sound
   * reasoning for a prompt that nags. But Windows has not let an application
   * make itself the default since Windows 8, so this card is the *only* route
   * there is. Capping it meant somebody who dismissed it twice could never find
   * it again and the browser silently stayed non-default for ever, which is the
   * state the user was actually in when they reported it.
   *
   * So it now offers on every launch until Slash genuinely is the default. The
   * two things that stop it are unchanged and are both definitive: it *is* the
   * default, or the user pressed "Don't ask again".
   */
  it('keeps offering the next day, because nothing else can make it default', () => {
    const asked = state({ asks: 1, lastAskedAt: NOW - 24 * 60 * 60 * 1000 })
    expect(shouldOfferDefault(asked, NOW)).toBe(true)
  })

  it('keeps offering however many times it has been shown', () => {
    const asked = state({ asks: 99, lastAskedAt: NOW - 1000 })
    expect(shouldOfferDefault(asked, NOW)).toBe(true)
  })

  it('stops the moment Slash actually is the default', () => {
    // The only outcome that should end this permanently, and it ends it without
    // the user having to dismiss anything.
    const asked = state({ isDefault: true, asks: 99, lastAskedAt: NOW - 1000 })
    expect(shouldOfferDefault(asked, NOW)).toBe(false)
  })
})

describe('openTargetFromArgv', () => {
  it.each(['pdf', 'svg', 'webp', 'html', 'htm'])('opens a .%s Windows handed us', (ext) => {
    // These must stay in step with `fileAssociations` in electron-builder.yml.
    // Claiming a type in the installer and then ignoring the path opens Slash
    // to a blank tab, which is worse than never claiming it — and it is what
    // happened when PDFs were associated while this only accepted .html.
    const opened = openTargetFromArgv(['C:/Slash/Slash.exe', `C:/docs/report.${ext}`])
    expect(opened).toBe(`file:///C:/docs/report.${ext}`)
  })

  it('does not treat a drive letter as a URL scheme', () => {
    expect(openTargetFromArgv(['C:/Slash/Slash.exe', 'C:/docs/a.pdf'])).toContain('file:///C:/')
  })

  it('ignores a file type Slash cannot render', () => {
    // An association for something that would land on a download prompt is
    // worse than no association at all.
    expect(openTargetFromArgv(['C:/Slash/Slash.exe', 'C:/docs/archive.zip'])).toBeNull()
  })

  it('opens a URL Windows handed us', () => {
    expect(openTargetFromArgv(['C:/Slash/Slash.exe', 'https://example.com/a?b=c'])).toBe(
      'https://example.com/a?b=c'
    )
  })

  it('ignores the executable itself', () => {
    // argv[0] is a path, and one that ends in .exe would otherwise be a target.
    expect(openTargetFromArgv(['C:/Slash/Slash.exe'])).toBeNull()
  })

  it('ignores flags, including ours', () => {
    expect(openTargetFromArgv(['Slash.exe', '--new-private-window', '--profile=work'])).toBeNull()
  })

  it('finds the URL among flags', () => {
    expect(openTargetFromArgv(['Slash.exe', '--new-window', 'https://example.com'])).toBe(
      'https://example.com'
    )
  })

  it('ignores the project directory Electron passes in development', () => {
    // `electron .` — a real path, and opening it would be a surprise every launch.
    expect(openTargetFromArgv(['electron.exe', '.'])).toBeNull()
    expect(openTargetFromArgv(['electron.exe', 'D:/Projects/Slash Browser'])).toBeNull()
  })

  it('opens a local HTML file, from the .html association', () => {
    expect(openTargetFromArgv(['Slash.exe', 'C:\\pages\\index.html'])).toBe(
      'file:///C:/pages/index.html'
    )
  })

  it('refuses anything that is not a web page', () => {
    // A caller must not be able to talk the browser into opening a scheme we
    // never registered for.
    expect(openTargetFromArgv(['Slash.exe', 'javascript:alert(1)'])).toBeNull()
    expect(openTargetFromArgv(['Slash.exe', 'C:/secrets/keys.txt'])).toBeNull()
    expect(openTargetFromArgv(['Slash.exe', 'ftp://example.com'])).toBeNull()
  })
})

describe('toFileUrl', () => {
  it('escapes a path with spaces', () => {
    expect(toFileUrl('C:\\Program Files\\a.html')).toBe('file:///C:/Program%20Files/a.html')
  })

  it('keeps the drive colon readable', () => {
    expect(toFileUrl('D:/x.html')).toBe('file:///D:/x.html')
  })
})

describe('parseUserChoiceProgId', () => {
  const output = [
    '',
    String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice`,
    '    Hash    REG_SZ    3vN0BxK7Xt0=',
    '    ProgId    REG_SZ    ChromeHTML',
    ''
  ].join('\r\n')

  it('reads the ProgId Windows will actually use', () => {
    expect(parseUserChoiceProgId(output)).toBe('ChromeHTML')
  })

  it('is not confused by the Hash line above it', () => {
    expect(parseUserChoiceProgId(output)).not.toContain('=')
  })

  it('says nothing when the key does not exist', () => {
    // A machine that has never had a default set. Not an error.
    expect(parseUserChoiceProgId('ERROR: The system was unable to find the specified registry key')).toBeNull()
    expect(parseUserChoiceProgId('')).toBeNull()
  })

  it('recognises Slash, and only Slash', () => {
    expect(isSlashProgId('SlashHTM')).toBe(true)
    expect(isSlashProgId('slashhtm')).toBe(true)
    expect(isSlashProgId('ChromeHTML')).toBe(false)
    expect(isSlashProgId('SlashHTMX')).toBe(false)
    expect(isSlashProgId(null)).toBe(false)
  })
})
