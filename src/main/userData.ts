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
