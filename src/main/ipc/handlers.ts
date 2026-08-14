import { app } from 'electron'
import { ok, err } from '@shared/result'
import { isInternalUrl } from '@shared/types/tab'
import { DEFAULT_WORKSPACE_ID } from '@shared/types/workspace'
import type { AppContext } from '../AppContext'
import { resolveInput } from '../navigation/UrlResolver'

/**
 * Registers every Phase 1 channel. Each must already exist in
 * `shared/ipc/contracts.ts` — `IpcRegistry.handle` refuses unknown channels, so
 * a handler cannot come into being without a validated payload shape.
 */
export function registerHandlers(ctx: AppContext): void {
  const { ipc } = ctx

  /** Resolves the window that owns the calling view. */
  const windowOf = (sender: Electron.WebContents) => ctx.windowFor(sender)

  const bookmarksChanged = (): void => {
    const all = ctx.bookmarks.list()
    for (const window of [ctx.focusedWindow()]) {
      if (window) ipc.broadcast('bookmarks:changed', all, window.privilegedContents())
    }
  }

  // --- app / diagnostics ----------------------------------------------------

  ipc.handle('app:info', () =>
    ok({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      platform: process.platform
    })
  )

  ipc.handle('diagnostics:dbStatus', () => {
    const status = ctx.db.status()
    return ok({ ...status, roundTripOk: ctx.db.probeRoundTrip() })
  })

  // --- settings -------------------------------------------------------------

  ipc.handle('settings:getAll', () => ok(ctx.settings.getAll()))
  ipc.handle('settings:update', (patch) => ok(ctx.settings.update(patch)))

  // --- overlay --------------------------------------------------------------

  ipc.handle('overlay:setState', (next, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window is associated with this view')

    const state =
      next.visible && next.surface !== 'none'
        ? window.overlay.show(next.surface, window.fullBounds())
        : window.overlay.hide()

    ipc.broadcast('overlay:stateChanged', state, window.privilegedContents())
    return ok(state)
  })

  ipc.handle('layout:setRightPanelWidth', (request, context) => {
    windowOf(context.sender)?.setRightPanelWidth(request.width)
    return ok(undefined)
  })

  // --- tabs -----------------------------------------------------------------

  ipc.handle('tabs:list', (_req, context) => {
    const window = windowOf(context.sender)
    return window ? ok(window.tabs.snapshot()) : err('NOT_FOUND', 'No window for this view')
  })

  ipc.handle('tabs:create', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.create(request)
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:close', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.close(request.tabId)
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:activate', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.activate(request.tabId)
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:reorder', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.reorder(request.tabId, request.toIndex)
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:setPinned', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.setPinned(request.tabId, request.pinned)
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:setMuted', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.setMuted(request.tabId, request.muted)
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:duplicate', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.duplicate(request.tabId)
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:reopenClosed', (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.reopenClosed()
    return ok(window.tabs.emitNow())
  })

  ipc.handle('tabs:findByUrl', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(window.tabs.findByUrl(request.url))
  })

  ipc.handle('tabs:moveToWorkspace', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    if (!ctx.workspaces.findById(request.workspaceId)) {
      return err('NOT_FOUND', 'That workspace no longer exists')
    }
    const reloaded = window.tabs.moveToWorkspace(request.tabId, request.workspaceId)
    window.tabs.emitNow()
    return ok({ reloaded })
  })

  // --- workspaces -----------------------------------------------------------

  /** Workspaces are global, but the active one is per-window. */
  const workspacesSnapshot = (window: ReturnType<typeof windowOf>) => ({
    workspaces: ctx.workspaces.list(),
    activeWorkspaceId: window?.tabs.currentWorkspaceId ?? DEFAULT_WORKSPACE_ID
  })

  const emitWorkspaces = (window: ReturnType<typeof windowOf>) => {
    const snapshot = workspacesSnapshot(window)
    if (window) ipc.broadcast('workspaces:snapshot', snapshot, window.privilegedContents())
    return snapshot
  }

  ipc.handle('workspaces:list', (_req, context) => ok(workspacesSnapshot(windowOf(context.sender))))

  ipc.handle('workspaces:create', (request, context) => {
    ctx.workspaces.create(request)
    return ok(emitWorkspaces(windowOf(context.sender)))
  })

  ipc.handle('workspaces:update', (request, context) => {
    const { id, ...patch } = request
    ctx.workspaces.update(id, patch)
    return ok(emitWorkspaces(windowOf(context.sender)))
  })

  ipc.handle('workspaces:delete', (request, context) => {
    const window = windowOf(context.sender)
    if (request.id === DEFAULT_WORKSPACE_ID) {
      return err('UNSUPPORTED', 'The default workspace cannot be deleted')
    }
    // Switch away first if this window is currently viewing it, so the user is
    // never left looking at a workspace that no longer exists.
    if (window?.tabs.currentWorkspaceId === request.id) {
      window.tabs.setActiveWorkspace(DEFAULT_WORKSPACE_ID)
    }
    window?.tabs.discardWorkspace(request.id)
    ctx.workspaces.delete(request.id)
    window?.tabs.emitNow()
    return ok(emitWorkspaces(window))
  })

  ipc.handle('workspaces:activate', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    if (!ctx.workspaces.findById(request.id)) return err('NOT_FOUND', 'That workspace is gone')
    window.tabs.setActiveWorkspace(request.id)
    window.tabs.emitNow()
    return ok(emitWorkspaces(window))
  })

  ipc.handle('workspaces:duplicate', (request, context) => {
    const window = windowOf(context.sender)
    const source = ctx.workspaces.findById(request.id)
    if (!source) return err('NOT_FOUND', 'That workspace is gone')

    const copy = ctx.workspaces.create({
      name: `${source.name} copy`,
      icon: source.icon,
      color: source.color,
      // Duplicating is the supported route to an isolated copy, since `isolated`
      // cannot be toggled on an existing workspace without stranding its cookies.
      isolated: request.isolated
    })

    // Copy the open tabs by URL. Their session state does not come along — an
    // isolated copy starts signed out by definition.
    if (window) {
      const urls = window.tabs
        .allTabs()
        .filter((t) => t.snapshot.workspaceId === source.id && !isInternalUrl(t.snapshot.url))
        .map((t) => t.snapshot.url)

      const previous = window.tabs.currentWorkspaceId
      window.tabs.setActiveWorkspace(copy.id)
      for (const url of urls) window.tabs.create({ url, background: true })
      window.tabs.setActiveWorkspace(previous)
      window.tabs.emitNow()
    }

    return ok(emitWorkspaces(window))
  })

  // --- navigation -----------------------------------------------------------

  ipc.handle('nav:navigate', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    // URL-vs-search is decided here, in one tested place, rather than in the
    // renderer where it would be duplicated per entry point.
    const resolved = resolveInput(request.input, ctx.settings.getAll().searchEngineId)
    window.tabs.navigate(request.tabId, resolved.url)
    return ok({ url: resolved.url })
  })

  ipc.handle('nav:goBack', (request, context) => {
    windowOf(context.sender)?.tabs.goBack(request.tabId)
    return ok(undefined)
  })

  ipc.handle('nav:goForward', (request, context) => {
    windowOf(context.sender)?.tabs.goForward(request.tabId)
    return ok(undefined)
  })

  ipc.handle('nav:reload', (request, context) => {
    windowOf(context.sender)?.tabs.reload(request.tabId, request.ignoreCache)
    return ok(undefined)
  })

  ipc.handle('nav:stop', (request, context) => {
    windowOf(context.sender)?.tabs.stop(request.tabId)
    return ok(undefined)
  })

  // --- performance ----------------------------------------------------------

  ipc.handle('performance:snapshot', (_req, context) => {
    const window = windowOf(context.sender)
    return window ? ok(window.performance.snapshot()) : err('NOT_FOUND', 'No window for this view')
  })

  ipc.handle('performance:setMode', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    // Persisted too, so the choice survives a restart and applies to new windows.
    ctx.settings.update({ performanceMode: request.mode })
    window.performance.policy.setMode(request.mode)
    return ok(window.performance.snapshot())
  })

  ipc.handle('performance:setProtected', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.tabs.setProtected(request.tabId, request.isProtected)
    return ok(window.performance.snapshot())
  })

  // Manual hibernate still runs the guards: a button press is not a reason to
  // destroy a half-filled form. `applied: false` tells the UI to explain why.
  ipc.handle('performance:hibernate', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok({ applied: window.performance.hibernateManually(request.tabId) })
  })

  ipc.handle('performance:freeze', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok({ applied: window.performance.freezeManually(request.tabId) })
  })

  ipc.handle('performance:restore', (request, context) => {
    windowOf(context.sender)?.tabs.restore(request.tabId)
    return ok(undefined)
  })

  ipc.handle('performance:applyRecommendation', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok({ applied: window.performance.applyRecommendation(request.tabIds) })
  })

  // --- history --------------------------------------------------------------

  ipc.handle('history:search', (request) =>
    ok(ctx.history.search(request.query, request.limit, request.offset))
  )

  ipc.handle('history:delete', (request, context) => {
    ctx.history.deleteByIds(request.ids)
    const window = windowOf(context.sender)
    if (window) ipc.broadcast('history:changed', {}, window.privilegedContents())
    return ok(undefined)
  })

  ipc.handle('history:clear', (request, context) => {
    ctx.history.clear(request.since)
    const window = windowOf(context.sender)
    if (window) ipc.broadcast('history:changed', {}, window.privilegedContents())
    return ok(undefined)
  })

  // --- bookmarks ------------------------------------------------------------

  ipc.handle('bookmarks:list', () => ok(ctx.bookmarks.list()))

  ipc.handle('bookmarks:create', (request) => {
    // An internal page has no meaningful address to return to.
    if (!request.isFolder && isInternalUrl(request.url)) {
      return err('UNSUPPORTED', 'Internal pages cannot be bookmarked')
    }
    const created = ctx.bookmarks.create(request)
    bookmarksChanged()
    return ok(created)
  })

  ipc.handle('bookmarks:update', (request) => {
    const updated = ctx.bookmarks.update(request)
    bookmarksChanged()
    return ok(updated)
  })

  ipc.handle('bookmarks:delete', (request) => {
    ctx.bookmarks.delete(request.id)
    bookmarksChanged()
    return ok(undefined)
  })

  ipc.handle('bookmarks:findByUrl', (request) => ok(ctx.bookmarks.findByUrl(request.url)))

  // --- downloads ------------------------------------------------------------

  ipc.handle('downloads:list', () => ok(ctx.downloads.list()))
  ipc.handle('downloads:pause', (request) => {
    ctx.downloads.pause(request.id)
    return ok(undefined)
  })
  ipc.handle('downloads:resume', (request) => {
    ctx.downloads.resume(request.id)
    return ok(undefined)
  })
  ipc.handle('downloads:cancel', (request) => {
    ctx.downloads.cancel(request.id)
    return ok(undefined)
  })
  ipc.handle('downloads:openFile', async (request) => {
    await ctx.downloads.openFile(request.id)
    return ok(undefined)
  })
  ipc.handle('downloads:showInFolder', (request) => {
    ctx.downloads.showInFolder(request.id)
    return ok(undefined)
  })
  ipc.handle('downloads:remove', (request) => {
    ctx.downloads.remove(request.id)
    return ok(undefined)
  })
  ipc.handle('downloads:clearCompleted', () => {
    ctx.downloads.clearCompleted()
    return ok(undefined)
  })
}
