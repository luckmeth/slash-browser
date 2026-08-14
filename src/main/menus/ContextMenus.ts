import {
  Menu,
  clipboard,
  shell,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/constants'
import { isInternalUrl } from '@shared/types/tab'
import type { TabManager } from '../tabs/TabManager'
import type { WorkspaceRepository } from '../db/repositories/WorkspaceRepository'

export interface ContextMenuDeps {
  tabs: TabManager
  window: BaseWindow
  workspaces: WorkspaceRepository
  searchEngineId: () => SearchEngineId
  bookmarkUrl: (url: string, title: string) => void
  /** Confirmed before moving a tab across an isolation boundary. */
  moveTabToWorkspace: (tabId: string, workspaceId: string) => void
}

/**
 * Right-click menus.
 *
 * Their absence is one of the loudest signals that something is not a real
 * browser: users right-click a link expecting "Open in new tab" and get either
 * nothing or Electron's development menu. Chromium supplies the *parameters*
 * (`context-menu` event) but no menu — the menu itself has to be built here.
 */
export function installPageContextMenu(contents: WebContents, deps: ContextMenuDeps): void {
  contents.on('context-menu', (_event, params) => {
    const template = buildPageMenu(contents, params, deps)
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: deps.window })
  })
}

function buildPageMenu(
  contents: WebContents,
  params: ContextMenuParams,
  deps: ContextMenuDeps
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const separator: MenuItemConstructorOptions = { type: 'separator' }

  // --- spelling ------------------------------------------------------------
  // Offered first: when a word is flagged, correcting it is almost always why
  // the user right-clicked.
  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
      }
    } else {
      items.push({ label: 'No spelling suggestions', enabled: false })
    }
    items.push({
      label: 'Add to dictionary',
      click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
    })
    items.push(separator)
  }

  // --- link ----------------------------------------------------------------
  if (params.linkURL) {
    const url = params.linkURL
    items.push(
      {
        label: 'Open link in new tab',
        click: () => deps.tabs.create({ url, background: true })
      },
      {
        label: 'Open link in new tab and switch',
        click: () => deps.tabs.create({ url, background: false })
      },
      {
        label: 'Copy link address',
        click: () => clipboard.writeText(url)
      },
      separator
    )
  }

  // --- image ---------------------------------------------------------------
  if (params.hasImageContents && params.srcURL) {
    const src = params.srcURL
    items.push(
      { label: 'Open image in new tab', click: () => deps.tabs.create({ url: src, background: true }) },
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(src) },
      {
        label: 'Save image as…',
        // Routed through the normal download path, so it lands in the downloads
        // list and gets the same handling as any other file.
        click: () => contents.downloadURL(src)
      },
      separator
    )
  }

  // --- editable field ------------------------------------------------------
  if (params.isEditable) {
    items.push(
      { label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo },
      { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo },
      separator,
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
      { label: 'Select all', role: 'selectAll' },
      separator
    )
  } else if (params.selectionText) {
    const text = params.selectionText.trim()
    const shown = text.length > 30 ? `${text.slice(0, 30)}…` : text
    const engine = SEARCH_ENGINES[deps.searchEngineId()]
    items.push(
      { label: 'Copy', role: 'copy' },
      {
        label: `Search ${engine.name} for "${shown}"`,
        click: () =>
          deps.tabs.create({
            url: engine.url.replace('%s', encodeURIComponent(text)),
            background: true
          })
      },
      separator
    )
  }

  // --- page ----------------------------------------------------------------
  if (items.length === 0 || (!params.linkURL && !params.isEditable && !params.selectionText)) {
    items.push(
      {
        label: 'Back',
        enabled: contents.navigationHistory.canGoBack(),
        click: () => contents.navigationHistory.goBack()
      },
      {
        label: 'Forward',
        enabled: contents.navigationHistory.canGoForward(),
        click: () => contents.navigationHistory.goForward()
      },
      { label: 'Reload', click: () => contents.reload() },
      separator,
      {
        label: 'Save page as…',
        click: () => contents.downloadURL(contents.getURL())
      },
      { label: 'Print…', click: () => contents.print() },
      separator
    )
  }

  items.push({
    label: 'Inspect element',
    click: () => {
      contents.inspectElement(params.x, params.y)
      // Chromium focuses the inspected node but not the devtools window itself.
      if (contents.isDevToolsOpened()) contents.devToolsWebContents?.focus()
    }
  })

  return trimSeparators(items)
}

/**
 * Menu for right-clicking a tab. Invoked from the renderer rather than from a
 * Chromium event, because the tab strip is our own UI.
 */
export function showTabContextMenu(tabId: string, deps: ContextMenuDeps): void {
  const tab = deps.tabs.findById(tabId)
  if (!tab) return
  const snap = tab.snapshot
  const separator: MenuItemConstructorOptions = { type: 'separator' }

  const otherWorkspaces = deps.workspaces
    .list()
    .filter((workspace) => workspace.id !== snap.workspaceId)

  const template: MenuItemConstructorOptions[] = [
    { label: 'New tab to the right', click: () => deps.tabs.create({ afterTabId: tabId }) },
    { label: 'Reload', click: () => deps.tabs.reload(tabId, false) },
    { label: 'Duplicate', click: () => deps.tabs.duplicate(tabId) },
    separator,
    {
      label: snap.isPinned ? 'Unpin tab' : 'Pin tab',
      click: () => deps.tabs.setPinned(tabId, !snap.isPinned)
    },
    {
      label: snap.isMuted ? 'Unmute tab' : 'Mute tab',
      click: () => deps.tabs.setMuted(tabId, !snap.isMuted)
    },
    {
      label: snap.isProtected ? 'Allow this tab to sleep' : 'Never sleep this tab',
      click: () => deps.tabs.setProtected(tabId, !snap.isProtected)
    },
    separator,
    {
      label: 'Bookmark this tab',
      enabled: !isInternalUrl(snap.url),
      click: () => deps.bookmarkUrl(snap.url, snap.title || snap.url)
    },
    {
      label: 'Copy address',
      enabled: !isInternalUrl(snap.url),
      click: () => clipboard.writeText(snap.url)
    },
    {
      label: 'Open in system browser',
      enabled: snap.url.startsWith('http'),
      click: () => void shell.openExternal(snap.url)
    }
  ]

  if (otherWorkspaces.length > 0) {
    template.push(separator, {
      label: 'Move to workspace',
      submenu: otherWorkspaces.map((workspace) => ({
        // The lock hints that the move will sign the tab out there; the
        // confirmation dialog states it explicitly.
        label: `${workspace.icon} ${workspace.name}${workspace.isolated ? '  🔒' : ''}`,
        click: () => deps.moveTabToWorkspace(tabId, workspace.id)
      }))
    })
  }

  template.push(
    separator,
    { label: 'Close tab', click: () => deps.tabs.close(tabId) },
    { label: 'Close other tabs', click: () => deps.tabs.closeOthers(tabId) },
    { label: 'Close tabs to the right', click: () => deps.tabs.closeToRight(tabId) }
  )

  Menu.buildFromTemplate(template).popup({ window: deps.window })
}

/** Drops leading, trailing and doubled separators left by conditional sections. */
function trimSeparators(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of items) {
    const isSeparator = item.type === 'separator'
    if (isSeparator && (out.length === 0 || out[out.length - 1]?.type === 'separator')) continue
    out.push(item)
  }
  while (out.length > 0 && out[out.length - 1]?.type === 'separator') out.pop()
  return out
}
