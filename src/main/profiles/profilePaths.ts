/**
 * Which profile this launch is running as, and where its data lives.
 *
 * Pure, and it has to be: this runs **before `app.whenReady()`**, because
 * `app.setPath('userData', …)` only takes effect if it happens before anything
 * has opened a file under the old path. There is no second chance and no error
 * if it is late — the browser simply uses the wrong profile's data, silently,
 * and writes to it.
 *
 * A profile is a separate `userData` directory, which is what Chrome does too.
 * It is not a workspace: a workspace is a place to keep tabs inside one person's
 * browser, sharing their history, passwords and settings. A profile shares
 * nothing at all.
 */

/** Ids appear in a filesystem path, so they are constrained to what is safe there. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/

export const DEFAULT_PROFILE_ID = 'default'

export function isValidProfileId(id: string): boolean {
  return ID_PATTERN.test(id)
}

/**
 * An id from a display name.
 *
 * The id is never shown; it is a directory name. A name of only punctuation, or
 * of a script this transliteration does not cover, would otherwise produce an
 * empty string and a profile that writes to the parent directory.
 */
export function profileIdFrom(name: string, existing: readonly string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'profile'

  if (!existing.includes(base) && isValidProfileId(base)) return base

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, 40).replace(/-+$/, '')
    if (!existing.includes(candidate) && isValidProfileId(candidate)) return candidate
  }
  // Only reachable with a thousand identically-named profiles.
  return `profile-${Date.now()}`
}

/**
 * The profile named on the command line, if any.
 *
 * `--profile=work` or `--profile work`. Anything unrecognised returns null and
 * the caller falls back to the default — a typo must not create a new profile,
 * because a new profile looks exactly like all your data having vanished.
 */
export function profileFromArgv(argv: readonly string[]): string | null {
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim().toLowerCase()
      return isValidProfileId(value) ? value : null
    }
    if (arg === '--profile') {
      const value = (argv[index + 1] ?? '').trim().toLowerCase()
      return isValidProfileId(value) ? value : null
    }
  }
  return null
}

/**
 * Where a profile's data directory sits, given the app's normal userData path.
 *
 * The default profile keeps the original path exactly. That is not tidiness — it
 * is what makes this change invisible to every existing installation: an upgrade
 * must not move somebody's bookmarks, and moving the directory is precisely how
 * it would look as though it had lost them.
 */
export function userDataPathFor(baseUserData: string, profileId: string): string {
  if (profileId === DEFAULT_PROFILE_ID || !isValidProfileId(profileId)) return baseUserData
  // A sibling of the base directory rather than a child: nesting profiles inside
  // the default profile's folder would make the default one's "delete all data"
  // take every other profile with it.
  return `${baseUserData}-profile-${profileId}`
}

/** Where the shared profile list lives — outside any profile, so all of them see it. */
export function registryPathFor(baseUserData: string): string {
  return `${baseUserData}-profiles.json`
}
