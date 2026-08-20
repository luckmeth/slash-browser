import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron'
import type { UiCommand } from '@shared/ipc/contracts'
import type { AppContext } from './AppContext'

/**
 * The application menu, which on Windows is also how a browser gets its keyboard
 * shortcuts.
 *
 * Accelerators registered here work regardless of which native view has focus.
 * That matters because focus normally sits in the page view — a web page — so
 * `keydown` listeners in the chrome document never see Ctrl+T at all. Handling
 * these anywhere else would mean shortcuts that silently stop working the moment
 * the user clicks on a page.
 *
 * Commands that act on browser state are handled here directly. Commands that
 * depend on renderer state (which input has focus, which panel is open) are sent
 * to the UI as a `ui:command` event.
 */
export function buildApplicationMenu(ctx: AppContext): void {
  const withTabs = (fn: (tabs: NonNullable<ReturnType<AppContext['focusedWindow']>>['tabs']) => void) => () => {
    const window = ctx.focusedWindow()
    if (window) fn(window.tabs)
  }

  const send = (command: UiCommand['command']) => () => {
    const window = ctx.focusedWindow()
    if (window) ctx.ipc.broadcast('ui:command', { command }, window.privilegedContents())
  }

  /** Ctrl+1..8 select by position; Ctrl+9 selects the last tab, as in Chrome. */
  const selectByIndex = (index: number): MenuItemConstructorOptions => ({
    label: `Tab ${index + 1}`,
    accelerator: `CommandOrControl+${index + 1}`,
    click: withTabs((tabs) => {
      const { tabs: all } = tabs.snapshot()
      const target = index === 8 ? all[all.length - 1] : all[index]
      if (target) tabs.activate(target.id)
    })
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CommandOrControl+T',
          click: withTabs((tabs) => tabs.create({}))
        },
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+N',
          click: () => ctx.createWindow()
        },
        {
          label: 'New Private Window',
          accelerator: 'CommandOrControl+Shift+N',
          click: () => ctx.createWindow({ isPrivate: true })
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.close(id)
          })
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: withTabs((tabs) => tabs.reopenClosed())
        },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Focus Address Bar',
          accelerator: 'CommandOrControl+L',
          click: send('focus-omnibox')
        }
      ]
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.reload(id, false)
          })
        },
        {
          label: 'Reload Ignoring Cache',
          accelerator: 'CommandOrControl+Shift+R',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.reload(id, true)
          })
        },
        {
          label: 'Stop',
          accelerator: 'Escape',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.stop(id)
          })
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.goBack(id)
          })
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.goForward(id)
          })
        },
        { type: 'separator' },
        {
          label: 'Find in Page…',
          accelerator: 'CommandOrControl+F',
          click: send('open-find')
        },
        {
          label: 'Reader Mode',
          accelerator: 'F9',
          click: () => {
            const window = ctx.focusedWindow()
            if (!window) return
            void ctx.reader.extract(window.tabs.activeTab?.contents ?? null).then((result) => {
              // Silent when the page is not an article: a menu item cannot show
              // the explanation the toolbar button can, and an empty reader
              // would be worse than nothing happening.
              if (result.article) window.showReader(result)
            })
          }
        },
        {
          label: 'Search Tabs…',
          accelerator: 'CommandOrControl+Shift+A',
          // Straight to the window rather than through a ui:command: the surface
          // lives in the overlay, which main owns, so routing it via the chrome
          // renderer would be a round trip that changes nothing.
          click: () => ctx.focusedWindow()?.showTabSearch()
        },
        { type: 'separator' },
        {
          // Toggle rather than two items: the common case is "show me these two
          // pages at once", and the tab to pair with is almost always the one
          // next to it. Choosing a specific partner is the tab context menu's
          // job, where you are already pointing at the tab you mean.
          label: 'Split View',
          accelerator: 'CommandOrControl+Shift+S',
          click: withTabs((tabs) => {
            if (tabs.splitId) {
              tabs.setSplit(null)
              return
            }
            const { tabs: visible, activeTabId } = tabs.snapshot()
            const index = visible.findIndex((t) => t.id === activeTabId)
            const partner = visible[index + 1] ?? visible[index - 1]
            if (partner) tabs.setSplit(partner.id)
          })
        },
        {
          label: 'Swap Split Panes',
          click: withTabs((tabs) => tabs.swapSplit())
        },
        {
          label: 'Stack Split Panes',
          click: withTabs((tabs) =>
            tabs.setSplitOrientation(
              tabs.snapshot().splitOrientation === 'vertical' ? 'horizontal' : 'vertical'
            )
          )
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+Plus',
          click: withTabs((tabs) => stepZoom(tabs, 1))
        },
        {
          // Ctrl+= is what an unshifted "+" key actually produces.
          label: 'Zoom In ',
          accelerator: 'CommandOrControl+=',
          visible: false,
          click: withTabs((tabs) => stepZoom(tabs, 1))
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: withTabs((tabs) => stepZoom(tabs, -1))
        },
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.setZoomLevel(id, 0)
          })
        },
        { type: 'separator' },
        {
          // For sites that refuse browsers they do not recognise — Google
          // sign-in being the one people hit.
          label: 'Open in Default Browser',
          accelerator: 'CommandOrControl+Shift+E',
          click: () => {
            const tabs = ctx.focusedWindow()?.tabs
            const id = tabs?.snapshot().activeTabId
            const url = id ? (tabs?.findById(id)?.snapshot.url ?? '') : ''
            if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
          }
        },
        { type: 'separator' },
        {
          label: 'Print…',
          accelerator: 'CommandOrControl+P',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.print(id)
          })
        },
        {
          label: 'Full Screen',
          accelerator: 'F11',
          click: () => {
            const window = ctx.focusedWindow()?.browserWindow
            if (window) window.setFullScreen(!window.isFullScreen())
          }
        },
        { type: 'separator' },
        {
          // Devtools for the *page*, not for our chrome UI — that is what a user
          // pressing F12 in a browser expects to inspect.
          label: 'Developer Tools',
          accelerator: 'F12',
          click: () => {
            const tabs = ctx.focusedWindow()?.tabs
            const id = tabs?.snapshot().activeTabId
            if (!tabs || !id) return
            const contents = tabs.findById(id)?.contents
            if (contents?.isDevToolsOpened()) contents.closeDevTools()
            else contents?.openDevTools({ mode: 'bottom' })
          }
        }
      ]
    },
    {
      label: '&Tabs',
      submenu: [
        ...[0, 1, 2, 3, 4, 5, 6, 7].map(selectByIndex),
        {
          label: 'Last Tab',
          accelerator: 'CommandOrControl+9',
          click: withTabs((tabs) => {
            const all = tabs.snapshot().tabs
            const last = all[all.length - 1]
            if (last) tabs.activate(last.id)
          })
        },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'Control+Tab',
          click: withTabs((tabs) => cycle(tabs, 1))
        },
        {
          label: 'Previous Tab',
          accelerator: 'Control+Shift+Tab',
          click: withTabs((tabs) => cycle(tabs, -1))
        },
        { type: 'separator' },
        {
          label: 'Pin/Unpin Tab',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (!id) return
            const tab = tabs.findById(id)
            if (tab) tabs.setPinned(id, !tab.snapshot.isPinned)
          })
        },
        {
          label: 'Duplicate Tab',
          click: withTabs((tabs) => {
            const id = tabs.snapshot().activeTabId
            if (id) tabs.duplicate(id)
          })
        }
      ]
    },
    {
      label: '&Workspaces',
      submenu: [
        ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
          label: `Workspace ${index + 1}`,
          accelerator: `CommandOrControl+Shift+${index + 1}`,
          click: () => {
            const window = ctx.focusedWindow()
            const workspace = ctx.workspaces.list()[index]
            if (!window || !workspace) return
            window.tabs.setActiveWorkspace(workspace.id)
            window.tabs.emitNow()
            ctx.ipc.broadcast(
              'workspaces:snapshot',
              { workspaces: ctx.workspaces.list(), activeWorkspaceId: workspace.id },
              window.privilegedContents()
            )
          }
        })),
        { type: 'separator' },
        {
          label: 'Next Workspace',
          accelerator: 'CommandOrControl+Shift+]',
          click: () => cycleWorkspace(ctx, 1)
        },
        {
          label: 'Previous Workspace',
          accelerator: 'CommandOrControl+Shift+[',
          click: () => cycleWorkspace(ctx, -1)
        }
      ]
    },
    {
      label: '&Library',
      submenu: [
        {
          label: 'Bookmark This Tab',
          accelerator: 'CommandOrControl+D',
          click: send('bookmark-current-tab')
        },
        { type: 'separator' },
        {
          // Ctrl+D bookmarks, Ctrl+Shift+D queues. Adjacent keys for adjacent
          // ideas, and the labels say which is the permanent one.
          label: 'Save to Reading List',
          accelerator: 'CommandOrControl+Shift+D',
          click: send('save-to-reading')
        },
        { label: 'Reading List', click: send('open-reading') },
        { type: 'separator' },
        { label: 'History', accelerator: 'CommandOrControl+H', click: send('open-history') },
        { label: 'Bookmarks', accelerator: 'CommandOrControl+Shift+O', click: send('open-bookmarks') },
        { label: 'Downloads', accelerator: 'CommandOrControl+J', click: send('open-downloads') },
        { type: 'separator' },
        {
          label: 'Performance',
          accelerator: 'CommandOrControl+Shift+P',
          click: send('open-performance')
        },
        {
          label: 'Mission Mode…',
          accelerator: 'CommandOrControl+Shift+M',
          click: send('open-mission')
        },
        {
          label: 'Redirect X-Ray…',
          accelerator: 'CommandOrControl+Shift+X',
          click: send('open-redirects')
        },
        {
          label: 'Page Insight…',
          accelerator: 'CommandOrControl+Shift+U',
          click: send('open-insight')
        },
        {
          label: 'Tab Brain…',
          accelerator: 'CommandOrControl+Shift+G',
          click: send('open-tabbrain')
        },
        {
          label: 'Search Browsing Memory…',
          accelerator: 'CommandOrControl+Shift+F',
          click: send('open-memory')
        },
        {
          label: 'Assistant…',
          accelerator: 'CommandOrControl+Shift+Y',
          click: send('open-ai')
        },
        { label: 'Site Permissions', click: send('open-permissions') },
        {
          label: 'Restore Points…',
          accelerator: 'CommandOrControl+Shift+K',
          click: send('open-timemachine')
        },
        { label: 'Settings', accelerator: 'CommandOrControl+,', click: send('open-settings') }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setName('Slash')
}

/** One Chromium zoom step is a factor of 1.2, which is 0.5 in level units. */
function stepZoom(
  tabs: NonNullable<ReturnType<AppContext['focusedWindow']>>['tabs'],
  direction: 1 | -1
): void {
  const id = tabs.snapshot().activeTabId
  if (!id) return
  tabs.setZoomLevel(id, tabs.getZoomLevel(id) + direction * 0.5)
}

function cycleWorkspace(ctx: AppContext, direction: 1 | -1): void {
  const window = ctx.focusedWindow()
  if (!window) return
  const all = ctx.workspaces.list()
  if (all.length === 0) return

  const current = all.findIndex((w) => w.id === window.tabs.currentWorkspaceId)
  const next = all[(current + direction + all.length) % all.length]
  if (!next) return

  window.tabs.setActiveWorkspace(next.id)
  window.tabs.emitNow()
  ctx.ipc.broadcast(
    'workspaces:snapshot',
    { workspaces: all, activeWorkspaceId: next.id },
    window.privilegedContents()
  )
}

function cycle(
  tabs: NonNullable<ReturnType<AppContext['focusedWindow']>>['tabs'],
  direction: 1 | -1
): void {
  const { tabs: all, activeTabId } = tabs.snapshot()
  if (all.length === 0) return
  const current = all.findIndex((t) => t.id === activeTabId)
  const next = all[(current + direction + all.length) % all.length]
  if (next) tabs.activate(next.id)
}
