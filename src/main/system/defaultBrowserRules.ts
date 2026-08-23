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
  if (state.suppressed) return false
  if (state.asks >= PROMPT_LIMITS.maxAsks) return false
  if (state.lastAskedAt > 0 && now - state.lastAskedAt < PROMPT_LIMITS.minGapMs) return false
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
export function openTargetFromArgv(argv: readonly string[]): string | null {
  // Skip argv[0]: it is the executable, and in development it is followed by
  // the project directory, which is a real path and must not be opened.
  for (const raw of argv.slice(1)) {
    const arg = raw.trim()
    if (arg === '' || arg.startsWith('-')) continue

    if (/^https?:\/\//i.test(arg)) return arg
    if (/^file:\/\//i.test(arg)) return arg

    // A local page, from the .htm/.html association. The scheme test demands
    // two or more characters before the colon on purpose: `C:\pages\a.html` is
    // a path, and a one-character "scheme" on Windows is always a drive letter.
    if (/\.x?html?$/i.test(arg) && !/^[a-z][a-z0-9+.-]+:/i.test(arg)) {
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
