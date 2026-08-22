import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_PROFILE_ID,
  isValidProfileId,
  profileIdFrom,
  registryPathFor,
  userDataPathFor
} from './profilePaths'
import { createLogger } from '../logger'

const log = createLogger('profiles')

export interface Profile {
  readonly id: string
  readonly name: string
  readonly createdAt: number
}

/**
 * The list of profiles on this machine.
 *
 * Stored as one JSON file **beside** every profile directory rather than inside
 * one of them. Keeping it inside the default profile would mean deleting that
 * profile lost the list of all the others, and clearing its data would make
 * every other profile disappear from the switcher while its files sat on disk.
 *
 * Deliberately plain JSON and not SQLite: it has to be read before
 * `app.setPath('userData', …)`, which is before the database exists.
 */
export class ProfileRegistry {
  private profiles: Profile[] = []

  constructor(private readonly baseUserData: string) {
    this.load()
  }

  private get path(): string {
    return registryPathFor(this.baseUserData)
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) {
        this.profiles = [defaultProfile()]
        return
      }
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      const list = Array.isArray(raw) ? raw : []
      this.profiles = list
        .map((entry) => toProfile(entry))
        .filter((entry): entry is Profile => entry !== null)

      // The default always exists, whatever the file says. Its directory is the
      // one every existing installation is already using.
      if (!this.profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID)) {
        this.profiles.unshift(defaultProfile())
      }
    } catch (error) {
      // A corrupt list must not stop the browser starting. Falling back to the
      // default profile leaves every other profile's data untouched on disk, so
      // this is recoverable by fixing the file.
      log.warn('could not read the profile list; using the default profile only', error)
      this.profiles = [defaultProfile()]
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.profiles, null, 2), 'utf8')
    } catch (error) {
      log.warn('could not save the profile list', error)
    }
  }

  list(): Profile[] {
    return [...this.profiles]
  }

  has(id: string): boolean {
    return this.profiles.some((profile) => profile.id === id)
  }

  create(name: string): Profile {
    const trimmed = name.trim() === '' ? 'New profile' : name.trim().slice(0, 60)
    const profile: Profile = {
      id: profileIdFrom(trimmed, this.profiles.map((entry) => entry.id)),
      name: trimmed,
      createdAt: Date.now()
    }
    this.profiles.push(profile)
    this.persist()
    return profile
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim().slice(0, 60)
    if (trimmed === '') return
    this.profiles = this.profiles.map((profile) =>
      profile.id === id ? { ...profile, name: trimmed } : profile
    )
    this.persist()
  }

  /**
   * Removes a profile and everything in it.
   *
   * The default cannot be deleted: it is the directory every existing
   * installation already uses, and there would be nothing to fall back to.
   *
   * The directory is **renamed aside** before being removed. A partial delete
   * that failed halfway would otherwise leave a half-erased profile that still
   * appears in the list and opens to a broken database; renaming first means the
   * profile is gone from this browser's point of view the instant the rename
   * succeeds, whatever happens to the bytes afterwards.
   */
  delete(id: string): { ok: boolean; reason: string } {
    if (id === DEFAULT_PROFILE_ID) {
      return { ok: false, reason: 'The first profile cannot be deleted.' }
    }
    if (!this.has(id)) return { ok: false, reason: 'That profile no longer exists.' }

    const directory = userDataPathFor(this.baseUserData, id)
    this.profiles = this.profiles.filter((profile) => profile.id !== id)
    this.persist()

    try {
      if (existsSync(directory)) {
        const aside = `${directory}-deleting-${Date.now()}`
        renameSync(directory, aside)
        rmSync(aside, { recursive: true, force: true })
      }
    } catch (error) {
      log.warn(`removed profile ${id} from the list, but its files could not be deleted`, error)
      return {
        ok: true,
        reason: 'The profile was removed, but some of its files could not be deleted.'
      }
    }

    return { ok: true, reason: '' }
  }

  directoryFor(id: string): string {
    return userDataPathFor(this.baseUserData, id)
  }
}

const defaultProfile = (): Profile => ({
  id: DEFAULT_PROFILE_ID,
  name: 'Default',
  createdAt: 0
})

function toProfile(entry: unknown): Profile | null {
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!isValidProfileId(id)) return null
  return {
    id,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : id,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0
  }
}
