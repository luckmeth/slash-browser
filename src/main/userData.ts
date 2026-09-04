import { ProfileRegistry } from './profiles/ProfileRegistry'
import { DEFAULT_PROFILE_ID } from './profiles/profilePaths'
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
export function prepareUserDataPath(): string {
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
    return scratch
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
        return legacy
      }
    }
  }

  app.setPath('userData', target)
  return target
}

/**
 * Points the browser at one profile's data directory.
 *
 * Must run immediately after `prepareUserDataPath` and before anything opens a
 * file — `app.setPath` only takes effect if nothing has read the old path yet,
 * and being late produces no error at all. The browser simply uses the wrong
 * profile's data and writes to it.
 *
 * The default profile keeps the base directory unchanged, so every existing
 * installation carries on exactly where it was.
 *
 * @returns the profile actually in use, which may not be the one asked for: an
 *   unknown id falls back to the default rather than silently creating a profile,
 *   because a new empty profile looks exactly like all your data having vanished.
 */
export function applyProfile(baseUserData: string, requested: string | null): string {
  const registry = new ProfileRegistry(baseUserData)
  const id = requested !== null && registry.has(requested) ? requested : DEFAULT_PROFILE_ID
  const directory = registry.directoryFor(id)
  app.setPath('userData', directory)
  return id
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
