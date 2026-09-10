import {
  Menu,
  clipboard,
  shell,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { togglePictureInPicture } from '../media/pictureInPicture'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import { SEARCH_ENGINES, type SearchEngineId } from '@shared/constants'
import { isInternalUrl } from '@shared/types/tab'
import type { TabManager } from '../tabs/TabManager'
import type { WorkspaceRepository } from '../db/repositories/WorkspaceRepository'
import { createLogger } from '../logger'

const log = createLogger('context-menu')

export interface ContextMenuDeps {
  tabs: TabManager
  window: BaseWindow
  workspaces: WorkspaceRepository
  /** May be a built-in id or one of the user's own engines. */
  searchEngineId: () => string
  bookmarkUrl: (url: string, title: string) => void
  /** Confirmed before moving a tab across an isolation boundary. */
  moveTabToWorkspace: (tabId: string, workspaceId: string) => void
  /** Hands a link to the segmented download engine. */
  enqueueDownload: (url: string) => void
  /**
   * Saved addresses that could fill this page, and how to fill one.
   *
   * Returns an empty list when the page has no address fields, so the entry
   * appears only where it would do something.
   */
  addressOffers: (contents: WebContents) => { id: number; label: string }[]
  fillAddress: (contents: WebContents, id: number) => void
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
    try {
      const template = buildPageMenu(contents, params, deps)
      if (template.length === 0) {
        log.warn('context menu built empty — nothing would have been shown')
        return
      }

      Menu.buildFromTemplate(template).popup({
        window: deps.window,
        // Chromium reports where the click happened; without these the menu
        // opens at wherever the OS thinks the pointer is, which on a multi-view
        // window is not reliably the same place.
        x: params.x,
        y: params.y,
        // Documented as needed for OS-level features to attach to the right
        // frame. Harmless when absent, and the menu is correct either way.
        ...(params.frame ? { frame: params.frame } : {})
      })
    } catch (error) {
      // Previously this threw into the event handler and vanished: the user saw
      // no menu, and nothing anywhere said why. One malformed template entry —
      // an undefined label from a setting nobody anticipated — was enough.
      log.error('context menu failed to open', error)
    }
  })
}

/** Exported for `SLASH_CONTEXTMENU_PROBE`, which builds it without popping it. */
export function buildPageMenu(
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
      }
    )

    // Only offered for http(s). The engine writes whatever it fetches to disk,
    // so a file:// or blob: link here would be a local file copy wearing a
    // download's clothes.
    if (/^https?:\/\//i.test(url)) {
      items.push({
        label: 'Download with Slash (managed)',
        click: () => deps.enqueueDownload(url)
      })
    }
    items.push(separator)
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

  // --- video ---------------------------------------------------------------
  // Only on a video, where it always applies — so unlike the View-menu entry
  // this one never has to explain that there was nothing to pop out.
  if (params.mediaType === 'video') {
    items.push(
      {
        label: 'Picture in picture',
        click: () => {
          void togglePictureInPicture(contents)
        }
      },
      separator
    )
  }

  // --- editable field ------------------------------------------------------
  if (params.isEditable) {
    // Offered only where the page actually has fields an address could fill, so
    // this never appears on a comment box or a search bar.
    const offers = deps.addressOffers(contents)
    if (offers.length > 0) {
      items.push(
        {
          label: 'Fill address',
          submenu: offers.map((offer) => ({
            label: offer.label,
            click: () => deps.fillAddress(contents, offer.id)
          }))
        },
        separator
      )
    }

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
    // Falls back to the schema default when the chosen engine is one of the
    // user's own, which this menu does not carry the list for.
    const engine =
      SEARCH_ENGINES[deps.searchEngineId() as SearchEngineId] ??
      SEARCH_ENGINES[DEFAULT_SETTINGS.searchEngineId as SearchEngineId]
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
      // The system dialog, deliberately: this entry is reached by right-clicking
      // a specific frame, and the preview renders the top-level page.
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
      // Groups are per-workspace, so only this workspace's are offered. A
      // submenu listing a group from elsewhere would be offering to drag the tab
      // across an isolation boundary, which reloads it signed out.
      label: 'Add to group',
      submenu: [
        {
          label: 'New group',
          click: () => {
            deps.tabs.createGroup([tabId], { name: '', color: 'blue' })
          }
        },
        ...(deps.tabs.snapshot().groups.length > 0 ? [separator] : []),
        ...deps.tabs.snapshot().groups.map((group) => ({
          label: group.name || 'Untitled group',
          type: 'checkbox' as const,
          checked: snap.groupId === group.id,
          click: () => deps.tabs.setTabGroup(tabId, group.id)
        })),
        ...(snap.groupId
          ? [
              separator,
              {
                label: 'Remove from group',
                click: () => deps.tabs.setTabGroup(tabId, null)
              }
            ]
          : [])
      ]
    },
    separator,
    // The specific-partner route into split view: you are already pointing at
    // the tab you want beside the current one. Disabled rather than hidden when
    // the window is too narrow, so the feature does not appear to come and go.
    ...(tabId === deps.tabs.splitId
      ? [
          {
            label: 'Remove from split view',
            click: () => deps.tabs.setSplit(null)
          }
        ]
      : tabId === deps.tabs.activeId
        ? []
        : [
            {
              label: 'Split view with this tab',
              // Also refused for an internal page. A tab showing the new tab
              // page has no page view to composite — the chrome document shows
              // through the content hole — so this used to be offered, clicked,
              // and silently do nothing. Greyed out says the same thing without
              // the click.
              enabled: deps.tabs.snapshot().canSplit && !isInternalUrl(snap.url),
              click: () => deps.tabs.setSplit(tabId)
            }
          ]),
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
        // Native menus cannot render our SVG icons, so isolation is spelled out
        // in words. The confirmation dialog states the consequence in full.
        label: workspace.isolated ? `${workspace.name} (isolated)` : workspace.name,
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
