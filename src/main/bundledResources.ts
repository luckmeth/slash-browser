import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Locates something shipped in `resources/`, in any way the app gets started.
 *
 * Packaged, it is beside `app.asar` — `extraResources` puts it there because a
 * native file open cannot read through the archive.
 *
 * Unpackaged, it depends on how Electron was launched, and this is the part
 * that bites. `app.getAppPath()` is the project root under `electron-vite`, but
 * running `electron out/main/index.js` directly makes it the *script's*
 * directory — so a path built from it silently points at nothing, and the
 * feature reports itself unavailable rather than crashing. That is how a
 * bundled binary can be present on disk, packaged correctly, and still missing
 * every time somebody runs a probe.
 *
 * So the candidates are tried in order and the first that exists wins. Returns
 * the packaged path when none do, so the error names the place it should have
 * been.
 */
export function bundledResource(...segments: string[]): string {
  const packaged = join(process.resourcesPath, ...segments)
  if (app.isPackaged) return packaged

  const candidates = [
    join(app.getAppPath(), 'resources', ...segments),
    // `electron out/main/index.js` — getAppPath is out/main, and the project
    // root is two levels up.
    join(app.getAppPath(), '..', '..', 'resources', ...segments),
    join(process.cwd(), 'resources', ...segments)
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? packaged
}
