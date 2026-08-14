import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'

/**
 * Path to the window/taskbar icon.
 *
 * In a packaged build electron-builder embeds the icon in the executable, so the
 * window inherits it automatically. In dev there is no embedded resource and the
 * window would otherwise show Electron's own logo — the single most obvious tell
 * that an app is an Electron shell.
 *
 * Returns undefined rather than a missing path: passing a non-existent icon to
 * BaseWindow logs a warning on some platforms.
 */
export function appIconPath(): string | undefined {
  if (app.isPackaged) return undefined

  // From out/main back to the repo root.
  const candidate = join(__dirname, '../../build/icon.png')
  return existsSync(candidate) ? candidate : undefined
}
