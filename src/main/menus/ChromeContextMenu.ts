import { Menu, clipboard, type BaseWindow, type WebContents } from 'electron'

/**
 * The right-click menu for Slash's own interface.
 *
 * `installPageContextMenu` is wired into **page views** by `ViewFactory`, and
 * the chrome document never got one — so right-clicking the address bar did
 * nothing at all. Not "showed a menu with the wrong items": nothing. Copying a
 * URL out of the omnibox, or pasting one in, was mouse-impossible.
 *
 * This is deliberately **much** smaller than the page menu. The chrome document
 * holds the privileged IPC bridge, so it gets editing commands and nothing
 * else: no "Inspect element", no "Save image as", no page actions. The one
 * addition beyond the clipboard roles is *Paste and go*, because pasting an
 * address and pressing Enter is the entire reason somebody right-clicks an
 * address bar.
 */
export interface ChromeMenuDeps {
  readonly window: BaseWindow
  /** Navigates the active tab to a pasted address. */
  readonly navigate: (input: string) => void
}

export function installChromeContextMenu(contents: WebContents, deps: ChromeMenuDeps): void {
  contents.on('context-menu', (_event, params) => {
    // Only in a text field. A right-click on the toolbar's empty space has
    // nothing to offer, and an "Undo / Redo / Cut" menu that is entirely
    // greyed out is worse than no menu.
    if (!params.isEditable && params.selectionText.trim() === '') return

    const template: Electron.MenuItemConstructorOptions[] = []

    if (params.isEditable) {
      template.push(
        { label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo },
        { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }
      )

      // The reason people reach for this menu in the first place.
      const pasted = clipboard.readText().trim()
      if (pasted !== '') {
        template.push({
          label: 'Paste and go',
          click: () => deps.navigate(pasted)
        })
      }

      template.push(
        { type: 'separator' },
        { label: 'Select all', role: 'selectAll', enabled: params.editFlags.canSelectAll }
      )
    } else {
      template.push({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy })
    }

    Menu.buildFromTemplate(template).popup({ window: deps.window })
  })
}
