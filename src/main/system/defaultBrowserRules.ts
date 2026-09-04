/**
 * Being the default browser: what can be asked, and when.
 *
 * Pure, because both halves are judgement calls with quiet failure modes. Read
 * a launch argument wrongly and clicking a link in another application opens a
 * blank window; ask too often and the browser becomes the thing people install
 * something else to get away from.
 */

/**
 * The ProgId the installer registers under `HKCU\Software\Classes`.
 *
 * Changing this string means changing `build/installer.nsh` in the same commit.
 * A mismatch does not fail anywhere — Slash simply stops appearing in Windows'
 * default-apps list, with nothing logged.
 */
export const SLASH_PROGID = 'SlashHTM'

/** How the prompt behaves once somebody has said no. */
export const PROMPT_LIMITS = {
  /**
   * How many times, ever.
   *
   * Two. The first ask is information — most people do not know a new browser
   * has to be told. The second covers somebody who meant to and forgot. A third
   * is nagging, and there is no version of nagging that reads as confidence in
   * the product.
   */
  maxAsks: 2,
  /** And not again for a fortnight. */
  minGapMs: 14 * 24 * 60 * 60 * 1000
} as const

export interface PromptState {
  /** Windows already reports Slash as the handler for http. */
  isDefault: boolean
  /** How many times the offer has been shown and declined. */
  asks: number
  /** When it was last shown. 0 if never. */
  lastAskedAt: number
  /** Somebody chose "don't ask again". */
  suppressed: boolean
}

/**
 * Whether to offer to make Slash the default.
 *
 * Never when it already is — an offer to do something already done reads as a
 * browser that cannot tell.
 */
export function shouldOfferDefault(state: PromptState, now: number): boolean {
  if (state.isDefault) return false
  // "Don't ask again" is still honoured — it is an explicit instruction, and
  // ignoring it would make the button a lie.
  if (state.suppressed) return false
  // The ask count and the fortnight gap are deliberately **not** consulted any
  // more. Windows will not let an application make itself the default, so this
  // card is the only route there is; capping it at two attempts a fortnight
  // meant somebody who dismissed it twice could never find it again, and the
  // browser then silently stayed non-default for ever. It now offers on every
  // launch until Slash genuinely is the default — at which point the first line
  // of this function stops it permanently.
  void now
  return true
}

/**
 * What a launch was asked to open.
 *
 * Windows starts the default browser as `Slash.exe "https://…"` — there is no
 * event for it, only a command line. A browser that ignores its own argv is a
 * browser that opens an empty window every time somebody clicks a link in their
 * mail client, which is worse than not being the default at all.
 *
 * Only web URLs and local HTML files, because those are the only associations
 * the installer registers. Anything else is a flag, a path Electron passed in
 * development, or something a caller should not be able to talk us into
 * opening.
 */
/**
 * File types Slash is registered to open, and can actually render.
 *
 * Chromium displays all of these natively, which is the bar for claiming one:
 * an association for a type that would land on a download prompt is worse than
 * no association.
 */
const OPENABLE_FILE = /\.(x?html?|pdf|svg|webp)$/i

export function openTargetFromArgv(argv: readonly string[]): string | null {
  // Skip argv[0]: it is the executable, and in development it is followed by
  // the project directory, which is a real path and must not be opened.
  for (const raw of argv.slice(1)) {
    const arg = raw.trim()
    if (arg === '' || arg.startsWith('-')) continue

    if (/^https?:\/\//i.test(arg)) return arg
    if (/^file:\/\//i.test(arg)) return arg

    // A local file, from one of the installer's associations. The scheme test
    // demands two or more characters before the colon on purpose:
    // `C:\pages\a.html` is a path, and a one-character "scheme" on Windows is
    // always a drive letter.
    //
    // This list must stay in step with `fileAssociations` in
    // electron-builder.yml. Registering a type the installer claims and then
    // ignoring the path Windows hands over opens Slash to a blank tab, which is
    // a worse outcome than never having claimed it — and it is exactly what
    // happened when PDFs were associated while this test still read `.html`
    // only.
    if (OPENABLE_FILE.test(arg) && !/^[a-z][a-z0-9+.-]+:/i.test(arg)) {
      return toFileUrl(arg)
    }
  }
  return null
}

/** `C:\a b\page.html` → `file:///C:/a%20b/page.html`. */
export function toFileUrl(path: string): string {
  const normalised = path.replace(/\\/g, '/')
  const withRoot = normalised.startsWith('/') ? normalised : `/${normalised}`
  return `file://${withRoot.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':')}`
}

/**
 * The ProgId Windows will actually use for a scheme.
 *
 * Parsed from `reg query` output, which looks like:
 *
 * ```
 * HKEY_CURRENT_USER\...\UrlAssociations\http\UserChoice
 *     Hash    REG_SZ    3vN0BxK7Xt0=
 *     ProgId    REG_SZ    ChromeHTML
 * ```
 *
 * This is read rather than `app.isDefaultProtocolClient` because that asks a
 * question we have contaminated: registering as a *handler* writes keys under
 * `HKCU\Software\Classes`, and a check that reads those can answer "yes, you
 * are the default" purely because we registered. The offer then never appears,
 * on every machine, with nothing logged — the failure looks exactly like the
 * feature having been forgotten.
 *
 * `UserChoice` is the key Windows itself consults, and nothing we do can write
 * it. Whatever is here is the truth.
 */
export function parseUserChoiceProgId(regOutput: string): string | null {
  for (const line of regOutput.split(/\r?\n/)) {
    const match = /^\s*ProgId\s+REG_SZ\s+(.+?)\s*$/i.exec(line)
    if (match?.[1]) return match[1]
  }
  return null
}

/** Whether that ProgId is ours. */
export function isSlashProgId(progId: string | null): boolean {
  return progId !== null && progId.trim().toLowerCase() === SLASH_PROGID.toLowerCase()
}
