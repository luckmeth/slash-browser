import { Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron'
import type { UiCommand } from '@shared/ipc/contracts'

export interface AppMenuDeps {
  window: BaseWindow
  /** Opens a new browser window; `isPrivate` picks the recording-nothing kind. */
  createWindow: (options: { isPrivate: boolean }) => void
  newTab: () => void
  /** Sends a `ui:command`, for the panels the renderer owns. */
  send: (command: UiCommand['command']) => void
  /** Overlay surfaces main owns directly. */
  showCommandPalette: () => void
  showShortcuts: () => void
  toggleSplit: () => void
  zoom: (step: number) => void
  resetZoom: () => void
  print: () => void
}

/**
 * The button every browser has and Slash did not.
 *
 * Its absence was the reason private browsing and the AI panel looked as though
 * they had never been built: both existed, both had accelerators, and neither
 * had anything you could *click*. A feature reachable only by a keyboard
 * shortcut nobody told you about is, from the user's side, missing.
 *
 * **Native rather than a React dropdown, deliberately.** A CSS menu in the
 * chrome document is composited under the page view and gets clipped at the
 * window edge — both of which have already bitten this codebase. An OS menu has
 * neither problem: it can extend past the window, and nothing can cover it.
 */
export function showAppMenu(deps: AppMenuDeps): void {
  const separator: MenuItemConstructorOptions = { type: 'separator' }

  const template: MenuItemConstructorOptions[] = [
    { label: 'New tab', accelerator: 'CommandOrControl+T', click: deps.newTab },
    {
      label: 'New window',
      accelerator: 'CommandOrControl+N',
      click: () => deps.createWindow({ isPrivate: false })
    },
    {
      // The item whose absence made the whole feature invisible.
      label: 'New private window',
      accelerator: 'CommandOrControl+Shift+N',
      click: () => deps.createWindow({ isPrivate: true })
    },
    separator,
    {
      label: 'History',
      accelerator: 'CommandOrControl+H',
      click: () => deps.send('open-history')
    },
    {
      label: 'Downloads',
      accelerator: 'CommandOrControl+J',
      click: () => deps.send('open-downloads')
    },
    {
      label: 'Bookmarks',
      accelerator: 'CommandOrControl+Shift+O',
      click: () => deps.send('open-bookmarks')
    },
    { label: 'Reading list', click: () => deps.send('open-reading') },
    separator,
    {
      label: 'Zoom',
      submenu: [
        { label: 'Zoom in', accelerator: 'CommandOrControl+Plus', click: () => deps.zoom(1) },
        { label: 'Zoom out', accelerator: 'CommandOrControl+-', click: () => deps.zoom(-1) },
        { label: 'Actual size', accelerator: 'CommandOrControl+0', click: deps.resetZoom }
      ]
    },
    { label: 'Find in page…', accelerator: 'CommandOrControl+F', click: () => deps.send('open-find') },
    { label: 'Print…', accelerator: 'CommandOrControl+P', click: deps.print },
    separator,
    {
      label: 'Split view',
      accelerator: 'CommandOrControl+Shift+S',
      click: deps.toggleSplit
    },
    {
      label: 'Command palette…',
      accelerator: 'CommandOrControl+K',
      click: deps.showCommandPalette
    },
    separator,
    {
      // Likewise invisible before this: built, and reachable only by a shortcut.
      label: 'AI assistant',
      accelerator: 'CommandOrControl+Shift+Y',
      click: () => deps.send('open-ai')
    },
    { label: 'Browsing memory', click: () => deps.send('open-memory') },
    { label: 'Performance', click: () => deps.send('open-performance') },
    { label: 'Restore points', click: () => deps.send('open-timemachine') },
    separator,
    {
      label: 'Keyboard shortcuts',
      accelerator: 'CommandOrControl+/',
      click: deps.showShortcuts
    },
    { label: 'Settings', accelerator: 'CommandOrControl+,', click: () => deps.send('open-settings') }
  ]

  Menu.buildFromTemplate(template).popup({ window: deps.window })
}
