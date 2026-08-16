import { join } from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import { app } from 'electron'

/** Folder under %APPDATA% holding the database, sessions and caches. */
const DATA_FOLDER = 'Slash'

/** What the folder was called before the browser was renamed. */
const LEGACY_FOLDERS = ['adaptive-browser', 'Adaptive Browser']

/**
 * Pins the user-data location and carries forward data from the old name.
 *
 * Electron derives `userData` from the app name, so renaming the product would
 * silently point the browser at an empty folder — history, bookmarks, saved
 * sessions and logins would all appear to have vanished while still sitting on
 * disk under the previous name.
 *
 * Setting the path explicitly also keeps dev and packaged builds on the same
 * profile, which they otherwise would not be: one takes its name from
 * package.json, the other from electron-builder's productName.
 *
 * Must run before anything reads a path, which means before `app.whenReady`.
 */
export function prepareUserDataPath(): void {
  const appData = app.getPath('appData')

  // Dev probes get a throwaway profile.
  //
  // Every probe quits through the normal shutdown, which records a session-end
  // snapshot — so running them against the real profile wrote whatever the probe
  // had navigated to into the user's restored session. That is how a dozen
  // wikipedia.org, news.ycombinator.com and example.com/clicked tabs came to
  // reopen on every launch. The probes were doing their job; they simply had no
  // business writing to a real profile.
  if (isProbeRun()) {
    const scratch = join(appData, `${DATA_FOLDER}-probe`)
    app.setPath('userData', scratch)
    return
  }

  const target = join(appData, DATA_FOLDER)

  if (!existsSync(target)) {
    const legacy = LEGACY_FOLDERS.map((name) => join(appData, name)).find((path) =>
      existsSync(path)
    )
    if (legacy) {
      try {
        // A rename rather than a copy: it is atomic on the same volume, so there
        // is no window where the data exists in two places and a crash could
        // leave the profile half-migrated.
        renameSync(legacy, target)
      } catch {
        // If the move fails — a file locked by another process, say — fall back
        // to the old location rather than starting the user from scratch.
        app.setPath('userData', legacy)
        return
      }
    }
  }

  app.setPath('userData', target)
}

/**
 * Whether this launch is a dev capture rather than someone browsing.
 *
 * Listed by prefix rather than by name so a probe added later is isolated by
 * default. Getting this wrong in the other direction — a probe silently writing
 * to the real profile — is the failure this exists to prevent, and it is not one
 * the probe's own output would ever reveal.
 */
function isProbeRun(): boolean {
  return Object.keys(process.env).some(
    (key) => key.startsWith('SLASH_') || key.startsWith('ADAPTIVE_')
  )
}
