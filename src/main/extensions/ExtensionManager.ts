import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from 'electron'
import type { ExtensionsStatus, LoadedExtension } from '@shared/types/extensions'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'
import { gapsFor } from './manifestGaps'

const log = createLogger('extensions')

/**
 * Unpacked extensions, loaded from folders the user picked.
 *
 * **What this is not.** It is not a store, and it cannot install from the Chrome
 * Web Store — Electron has no install flow and runs only a subset of the
 * extension APIs. Rather than hide that, every loaded extension is inspected and
 * the interface is told exactly which of the capabilities it asked for will not
 * work. An extension list that silently half-works is worse than none, because
 * the user blames their own machine.
 *
 * Electron discards loaded extensions when the app exits, so the *paths* are
 * what persist; each is re-loaded on boot.
 */
export class ExtensionManager {
  private status: LoadedExtension[] = []
  private session: Session | null = null

  constructor(private readonly settings: SettingsStore) {}

  /** Called once the default session exists. Loads whatever was remembered. */
  async attach(session: Session): Promise<void> {
    this.session = session
    const paths = this.settings.getAll().extensionPaths
    for (const path of paths) await this.loadOne(path)
  }

  getStatus(): ExtensionsStatus {
    return { extensions: [...this.status], supported: this.session !== null }
  }

  /**
   * Loads a folder and remembers it.
   *
   * @returns why it failed, or null on success.
   */
  async add(path: string): Promise<string | null> {
    if (!existsSync(join(path, 'manifest.json'))) {
      return 'That folder has no manifest.json, so it is not an unpacked extension.'
    }
    const already = this.settings.getAll().extensionPaths
    if (already.includes(path)) return 'That extension is already loaded.'

    const error = await this.loadOne(path)
    if (error) return error

    this.settings.update({ extensionPaths: [...already, path] })
    return null
  }

  async remove(id: string): Promise<void> {
    const entry = this.status.find((extension) => extension.id === id)
    this.status = this.status.filter((extension) => extension.id !== id)

    if (entry) {
      this.settings.update({
        extensionPaths: this.settings.getAll().extensionPaths.filter((path) => path !== entry.path)
      })
      try {
        this.session?.extensions.removeExtension(id)
      } catch (error) {
        // Already gone, or never really loaded. Removing our record is the part
        // that matters, and it has happened.
        log.debug('removeExtension threw', error)
      }
    }
  }

  private async loadOne(path: string): Promise<string | null> {
    const session = this.session
    if (!session) return 'Extensions are not available yet.'

    // Read the manifest ourselves rather than trusting the loaded object: a
    // folder that fails to load still has one, and its contents are how the
    // gaps below are worked out.
    let manifest: unknown = null
    try {
      manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))
    } catch {
      // Left null: a manifest we cannot read simply yields no gap analysis, and
      // `loadExtension` below will report the real reason it failed.
    }

    try {
      const loaded = await session.extensions.loadExtension(path, {
        // Content scripts on pages already open when the extension loads. Off
        // by default in Electron, and its absence is the commonest reason an
        // extension appears to do nothing at all.
        allowFileAccess: false
      })

      const gaps = gapsFor(loaded.manifest ?? manifest)
      this.status.push({
        id: loaded.id,
        name: loaded.name,
        version: loaded.version,
        path,
        manifestVersion: readManifestVersion(loaded.manifest ?? manifest),
        gaps,
        error: null
      })
      log.info(`loaded extension ${loaded.name} (${gaps.length} unsupported capabilities)`)
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Recorded rather than dropped, so a folder that will not load shows in
      // the list with its reason instead of silently vanishing.
      this.status.push({
        id: `failed:${path}`,
        name: path.split(/[\\/]/).pop() ?? path,
        version: '',
        path,
        manifestVersion: readManifestVersion(manifest),
        gaps: gapsFor(manifest),
        error: message
      })
      log.warn(`could not load extension at ${path}: ${message}`)
      return message
    }
  }
}

function readManifestVersion(manifest: unknown): number {
  if (typeof manifest !== 'object' || manifest === null) return 0
  const value = (manifest as Record<string, unknown>)['manifest_version']
  return typeof value === 'number' ? value : 0
}
