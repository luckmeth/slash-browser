import { app, shell } from 'electron'
import { ok, err } from '@shared/result'
import { isInternalUrl } from '@shared/types/tab'
import { originOf, hostOf } from '@shared/url'
import type { BlockingStatus } from '@shared/types/blocking'
import { DEFAULT_WORKSPACE_ID } from '@shared/types/workspace'
import type { AppContext } from '../AppContext'
import { resolveInput } from '../navigation/UrlResolver'
import { showTabContextMenu } from '../menus/ContextMenus'
import { buildSuggestions } from '../navigation/SuggestionEngine'
import { analyseTabs } from '../tabs/brain/tabAnalysis'
import { isDisabledForHost, toggleHost } from '../cleanup/cleanupRules'
import { parseQuery } from '../memory/parseQuery'
import { ActionExecutor } from '../ai/ActionExecutor'
import { ContextBuilder } from '../ai/ContextBuilder'
import type { BrowserWindowController } from '../windows/BrowserWindowController'

/**
 * Assembles the AI context for a window.
 *
 * A single helper so every AI channel builds context the same way — the egress
 * preview and the actual request must never be able to disagree about what is
 * sent.
 */
/**
 * Memory counters, including whether the semantic layer is usable *right now*.
 *
 * `semanticAvailable` reports what the machine can actually do rather than what
 * the build nominally supports — a missing vector extension or a model that
 * refuses to load is the user's reality, and the panel is not allowed to keep
 * offering something that will not work.
 */
function memoryStats(ctx: AppContext): ReturnType<AppContext['memoryRepository']['stats']> {
  const state = ctx.semantic.status().state
  return ctx.memoryRepository.stats(
    state !== 'unsupported',
    state === 'ready' || state === 'indexing' || state === 'preparing'
  )
}

/**
 * Browsing-memory rows for the omnibox, or nothing.
 *
 * Three guards, each of which exists to keep this off the typing path:
 *
 *  - **Off unless indexing is on.** The default install never runs this at all.
 *  - **Not for short queries.** One or two characters match half the index and
 *    rank meaninglessly, and it is the keystroke where latency is most visible.
 *  - **Not for addresses.** Someone typing "github.com/" wants that address, not
 *    an essay they once read about GitHub.
 *
 * Failure is silent and empty: the omnibox has four other sources and none of
 * them should be held up by this one.
 */
async function memorySuggestions(ctx: AppContext, query: string) {
  const trimmed = query.trim()
  if (trimmed.length < 4) return []
  if (!ctx.settings.getAll().indexHistory) return []
  if (resolveInput(trimmed, ctx.settings.getAll().searchEngineId).kind !== 'search') return []

  try {
    return await ctx.memorySearch.search(parseQuery(trimmed), 4)
  } catch {
    return []
  }
}

/** Shield state for a tab, assembled from the blocker and current settings. */
function blockingStatus(
  ctx: AppContext,
  window: BrowserWindowController,
  tabId: string
): BlockingStatus {
  const tab = window.tabs.findById(tabId)
  const host = tab ? hostOf(tab.snapshot.url) : ''
  const settings = ctx.settings.getAll()
  const counts = ctx.blocker.engine.counts

  const contentsId = tab?.contents?.id ?? null

  return {
    blockedOnPage: contentsId !== null ? ctx.blocker.countFor(contentsId) : 0,
    // The split is the recorded decisions themselves, so the categories always
    // sum to the total rather than being tallied separately and drifting.
    counts:
      contentsId !== null
        ? ctx.blocker.activity.countsFor(contentsId)
        : { ads: 0, trackers: 0, popups: 0, redirects: 0 },
    adsEnabled: settings.blockAds,
    maliciousEnabled: settings.blockMaliciousSites,
    popupsEnabled: settings.blockPopups,
    strictMode: settings.protectionMode === 'strict',
    host,
    siteAllowed: host !== '' && ctx.blocker.engine.isSiteAllowed(host),
    popupsAllowedHere: host !== '' && ctx.popups.isPopupAllowedFor(host),
    siteLocked: ctx.siteLockedTabs.has(tabId),
    ruleCount: counts.blocked,
    maliciousRuleCount: counts.malicious,
    recent: contentsId !== null ? [...ctx.blocker.activity.entriesFor(contentsId, 20)] : []
  }
}

function buildContext(
  ctx: AppContext,
  window: BrowserWindowController,
  includePageContent: boolean
): ContextBuilder {
  const snapshot = window.tabs.snapshot()
  return new ContextBuilder({
    tabs: snapshot.tabs,
    workspaces: ctx.workspaces.list(),
    activeWorkspaceId: window.tabs.currentWorkspaceId,
    excludedOrigins: ctx.settings.getAll().excludedOrigins,
    // Requires both the standing setting and this request's opt-in.
    includePageContent: includePageContent && ctx.settings.getAll().aiMayReadPageContent
  })
}

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

  ipc.handle('app:info', (_request, context) =>
    ok({
      isPrivate: windowOf(context.sender)?.isPrivate ?? false,
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
  ipc.handle('settings:update', (patch) => {
    const next = ctx.settings.update(patch)

    // Announce the change. Without this the value was written to SQLite and the
    // renderer never heard about it — the store only updates from this event, so
    // the UI kept rendering the old settings until the next launch. Toggles hid
    // it, because they are re-read whenever the panel reopens; the appearance
    // settings exposed it immediately, since they are supposed to repaint.
    for (const window of ctx.allWindows()) {
      ipc.broadcast('settings:changed', next, window.privilegedContents())
    }

    // Anything holding a derived copy of a setting has to be told too, or the
    // stored value and the engine's view of it drift apart.
    ctx.blocker.refreshAllowedSites()
    return ok(next)
  })

  // --- omnibox suggestions --------------------------------------------------

  ipc.handle('omnibox:suggest', async (request, context) => {
    const window = windowOf(context.sender)
    return ok(
      buildSuggestions(request.query, {
        history: ctx.history.suggest(request.query, 12),
        bookmarks: ctx.bookmarks.list(),
        openTabs: window ? window.tabs.snapshot().tabs : [],
        engineId: ctx.settings.getAll().searchEngineId,
        memory: await memorySuggestions(ctx, request.query)
      })
    )
  })

  ipc.handle('omnibox:setState', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    window.omniboxState = request.suggestions.length === 0 ? null : request

    if (request.suggestions.length === 0) {
      const hidden = window.overlay.hide()
      ipc.broadcast('overlay:stateChanged', hidden, window.privilegedContents())
    } else {
      // Sized to the list, not the window: overlay hit-testing is rectangular,
      // so a full-screen overlay would make the whole page unclickable while
      // the dropdown is open.
      const shown = window.overlay.show('command-bar', request.bounds)
      // The overlay document picks its surface from this event; without it the
      // dropdown data arrives but nothing is mounted to render it.
      ipc.broadcast('overlay:stateChanged', shown, window.privilegedContents())
      ipc.broadcast('omnibox:state', request, window.privilegedContents())
    }
    return ok(undefined)
  })

  ipc.handle('omnibox:accept', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    window.overlay.hide()

    // Switching to an already-open tab rather than opening a duplicate is the
    // point of the 'open-tab' suggestion kind.
    if (request.suggestion.kind === 'open-tab' && request.suggestion.tabId) {
      window.tabs.activate(request.suggestion.tabId)
    } else {
      // The overlay document does not track which tab is active, so an empty
      // tabId means "the current one" rather than being an error.
      const target = request.tabId || window.tabs.snapshot().activeTabId
      if (!target) return err('NOT_FOUND', 'No active tab to navigate')
      window.tabs.navigate(target, request.suggestion.url)
    }
    window.tabs.emitNow()
    return ok(undefined)
  })

  ipc.handle('omnibox:getState', (_req, context) =>
    ok(windowOf(context.sender)?.omniboxState ?? null)
  )

  ipc.handle('omnibox:dismiss', (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return ok(undefined)
    window.omniboxState = null
    const hidden = window.overlay.hide()
    ipc.broadcast('overlay:stateChanged', hidden, window.privilegedContents())
    return ok(undefined)
  })

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

  ipc.handle('layout:setChromeHeight', (request, context) => {
    windowOf(context.sender)?.setChromeHeight(request.height)
    return ok(undefined)
  })

  // --- tabs -----------------------------------------------------------------

  ipc.handle('tabs:list', (_req, context) => {
    const window = windowOf(context.sender)
    return window ? ok(window.tabs.snapshot()) : err('NOT_FOUND', 'No window for this view')
  })

  ipc.handle('tabs:listAll', (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok({
      tabs: window.tabs.allTabs().map((tab) => tab.snapshot),
      activeTabId: window.tabs.snapshot().activeTabId
    })
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

  // --- native browser behaviours --------------------------------------------

  ipc.handle('menu:showTabContextMenu', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    showTabContextMenu(request.tabId, window.contextMenuDeps())
    return ok(undefined)
  })

  ipc.handle('view:setZoomLevel', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok({ level: window.tabs.setZoomLevel(request.tabId, request.level) })
  })

  ipc.handle('view:find', (request, context) => {
    windowOf(context.sender)?.tabs.findInPage(request.tabId, request.text, {
      forward: request.forward,
      findNext: request.findNext
    })
    return ok(undefined)
  })

  ipc.handle('view:stopFind', (request, context) => {
    windowOf(context.sender)?.tabs.stopFindInPage(request.tabId, request.keepSelection)
    return ok(undefined)
  })

  ipc.handle('view:print', (request, context) => {
    windowOf(context.sender)?.tabs.print(request.tabId)
    return ok(undefined)
  })

  ipc.handle('shell:openTabExternally', (request, context) => {
    const tab = windowOf(context.sender)?.tabs.findById(request.tabId)
    const url = tab?.snapshot.url ?? ''

    // Only real web addresses. Handing the OS a file:// path or a custom scheme
    // from a UI button would be a way to launch arbitrary local handlers.
    if (!/^https?:\/\//i.test(url)) return ok({ opened: false })

    void shell.openExternal(url)
    return ok({ opened: true })
  })

  ipc.handle('window:toggleFullScreen', (_req, context) => {
    const window = windowOf(context.sender)?.browserWindow
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const next = !window.isFullScreen()
    window.setFullScreen(next)
    return ok({ fullScreen: next })
  })

  // --- permissions ----------------------------------------------------------

  ipc.handle('permissions:respond', (request) => {
    ctx.permissions.respond(request.requestId, request.policy)
    return ok(undefined)
  })

  ipc.handle('permissions:getPending', (_req, context) =>
    ok(windowOf(context.sender)?.pendingPermission ?? null)
  )

  ipc.handle('permissions:list', () => ok(ctx.permissions.listGrants()))

  ipc.handle('permissions:revoke', (request) => {
    ctx.permissions.revoke(request.partition, request.origin, request.kind)

    // Chromium caches some grants renderer-side, so a page already holding a
    // stream keeps it until the document is torn down. Reloading is the only
    // way to make revocation take effect immediately — the UI offers it rather
    // than doing it silently, because a reload discards page state.
    if (request.reloadTabs) {
      for (const window of ctx.allWindows()) {
        for (const tab of window.tabs.allTabs()) {
          if (originOf(tab.snapshot.url) !== request.origin) continue
          window.tabs.reload(tab.id, false)
        }
      }
    }
    return ok(ctx.permissions.listGrants())
  })

  ipc.handle('permissions:events', (request) => ok(ctx.permissions.listEvents(request.limit)))

  ipc.handle('permissions:clearEvents', () => {
    ctx.permissionRepository.clearEvents()
    return ok(undefined)
  })

  // --- time machine ---------------------------------------------------------

  ipc.handle('snapshots:list', () => ok(ctx.snapshotRepository.list()))

  ipc.handle('snapshots:detail', (request) => ok(ctx.snapshotRepository.detail(request.id)))

  ipc.handle('snapshots:create', async (request) => {
    await ctx.snapshots.capture('manual', request.label)
    return ok(ctx.snapshotRepository.list())
  })

  ipc.handle('snapshots:restore', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const detail = ctx.snapshotRepository.detail(request.id)
    if (!detail) return err('NOT_FOUND', 'That restore point no longer exists')

    let tabs = detail.tabs
    if (request.intoNewWorkspace) {
      const workspace = ctx.workspaces.create({
        name: detail.label.slice(0, 40),
        icon: 'wsHome',
        color: 'slate',
        // Never isolated: an isolated workspace has its own cookie partition, so
        // restoring into one would silently sign every tab out.
        isolated: false
      })
      tabs = tabs.map((tab) => ({ ...tab, workspaceId: workspace.id }))
      window.tabs.setActiveWorkspace(workspace.id)
      ipc.broadcast(
        'workspaces:snapshot',
        { workspaces: ctx.workspaces.list(), activeWorkspaceId: workspace.id },
        window.privilegedContents()
      )
    }

    const restored = window.tabs.restoreFromSnapshot(tabs, { activateFirst: true })
    return ok({ restored })
  })

  ipc.handle('snapshots:restoreTab', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const detail = ctx.snapshotRepository.detail(request.id)
    const tab = detail?.tabs[request.tabIndex]
    if (!tab) return err('NOT_FOUND', 'That tab is not in this restore point')

    // Into the current workspace: restoring one tab is a "bring this back here"
    // action, and sending it to a workspace the user is not looking at would
    // make it appear to have done nothing.
    const restored = window.tabs.restoreFromSnapshot(
      [{ ...tab, workspaceId: window.tabs.currentWorkspaceId }],
      { activateFirst: true }
    )
    return ok({ restored })
  })

  ipc.handle('snapshots:delete', (request) => {
    ctx.snapshotRepository.delete(request.id)
    return ok(ctx.snapshotRepository.list())
  })

  // --- web memory -----------------------------------------------------------

  ipc.handle('memory:search', async (request) => {
    const parsed = parseQuery(request.query)
    return ok({
      results: await ctx.memorySearch.search(parsed, request.limit),
      parsed
    })
  })

  ipc.handle('memory:stats', () => ok(memoryStats(ctx)))

  ipc.handle('memory:forget', (request) => {
    ctx.memoryRepository.forget(request.url)
    return ok(memoryStats(ctx))
  })

  ipc.handle('memory:clear', () => {
    ctx.memoryRepository.clearAll()
    return ok(memoryStats(ctx))
  })

  ipc.handle('memory:semanticStatus', () => ok(ctx.semantic.status()))

  ipc.handle('memory:setSemanticEnabled', async (request) => {
    // The setting is the source of truth, and writing it is what drives the
    // engine — so the toggle cannot end up saying one thing while the layer does
    // another, which is the failure mode of having both a switch and a "start".
    ctx.settings.update({ semanticSearchEnabled: request.enabled })
    if (request.enabled) {
      // Deliberately not awaited: the first enable downloads a model, and the
      // panel needs to render `preparing` with a progress bar rather than sit on
      // a pending invoke for two minutes.
      void ctx.semantic.enable()
    } else {
      await ctx.semantic.disable()
    }
    return ok(ctx.semantic.status())
  })

  // --- advanced download engine ---------------------------------------------

  ipc.handle('downloadEngine:list', () => ok(ctx.downloadEngine.list()))

  ipc.handle('downloadEngine:enqueue', (request) => {
    // http(s) only. The engine writes whatever it fetches to disk, so a file://
    // or data: URL here would turn a download button into an arbitrary local
    // file copy.
    if (!/^https?:\/\//i.test(request.url)) {
      return err('FORBIDDEN', 'Only http and https downloads are supported')
    }
    return ok({
      id: ctx.downloadEngine.enqueue(request.url, {
        priority: request.priority,
        startAfter: request.startAfter
      })
    })
  })

  ipc.handle('downloadEngine:pause', (request) => {
    ctx.downloadEngine.pause(request.id)
    return ok(undefined)
  })
  ipc.handle('downloadEngine:resume', (request) => {
    ctx.downloadEngine.resume(request.id)
    return ok(undefined)
  })
  ipc.handle('downloadEngine:cancel', (request) => {
    ctx.downloadEngine.cancel(request.id)
    return ok(undefined)
  })
  ipc.handle('downloadEngine:remove', (request) => {
    ctx.downloadEngine.remove(request.id)
    return ok(undefined)
  })
  ipc.handle('downloadEngine:setPriority', (request) => {
    ctx.downloadEngine.setPriority(request.id, request.priority)
    return ok(undefined)
  })
  ipc.handle('downloadEngine:startNow', (request) => {
    ctx.downloadEngine.startNow(request.id)
    return ok(undefined)
  })

  // --- mission mode ---------------------------------------------------------

  const missionStatus = (window: BrowserWindowController | undefined) => ({
    active: ctx.missions.active(),
    past: ctx.missions.past(),
    // The suggestion is pushed as it happens rather than recomputed here: it
    // belongs to the moment of navigation, not to whenever the panel refreshes.
    suggestion: window ? ctx.missionSuggestions.get(window.tabs.activeTab?.id ?? '') ?? null : null
  })

  ipc.handle('mission:status', (_req, context) => ok(missionStatus(windowOf(context.sender))))

  ipc.handle('mission:start', (request, context) => {
    ctx.missions.start(request.goal)
    return ok(missionStatus(windowOf(context.sender)))
  })

  ipc.handle('mission:complete', (_req, context) => {
    ctx.missions.complete()
    return ok(missionStatus(windowOf(context.sender)))
  })

  ipc.handle('mission:discard', (request, context) => {
    ctx.missions.discard(request.id)
    return ok(missionStatus(windowOf(context.sender)))
  })

  ipc.handle('mission:setNotes', (request, context) => {
    ctx.missions.setNotes(request.id, request.notes)
    return ok(missionStatus(windowOf(context.sender)))
  })

  ipc.handle('mission:saveForLater', (_req, context) => {
    const window = windowOf(context.sender)
    const mission = ctx.missions.active()
    const tab = window?.tabs.activeTab
    if (!mission || !tab) return err('NOT_FOUND', 'No active mission or tab')

    ctx.missions.addItem(mission.id, tab.snapshot.url, tab.snapshot.title, 'saved')
    // The suggestion is answered, so it stops being offered for this tab.
    ctx.missionSuggestions.delete(tab.id)
    return ok(missionStatus(window))
  })

  ipc.handle('mission:removeItem', (request, context) => {
    ctx.missions.removeItem(request.itemId)
    return ok(missionStatus(windowOf(context.sender)))
  })

  // --- page watching --------------------------------------------------------

  const watchStatus = (window: BrowserWindowController | undefined) => {
    const url = window?.tabs.activeTab?.snapshot.url ?? ''
    return {
      watching: url !== '' && ctx.watch.isWatching(url),
      pages: ctx.watch.list(),
      unseenCount: ctx.watch.unseenCount()
    }
  }

  ipc.handle('watch:status', (_req, context) => ok(watchStatus(windowOf(context.sender))))

  ipc.handle('watch:toggle', async (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const tab = window.tabs.activeTab
    if (!tab || !/^https?:\/\//i.test(tab.snapshot.url)) {
      return err('UNSUPPORTED', 'Only web pages can be watched')
    }

    if (ctx.watch.isWatching(tab.snapshot.url)) {
      ctx.watch.unwatch(tab.snapshot.url)
    } else {
      ctx.watch.watch(tab.snapshot.url, tab.snapshot.title)
      // Capture the baseline immediately, so the very next visit can be compared
      // rather than being spent establishing what the page looked like.
      await ctx.watch.checkPage(tab.contents, tab.snapshot.url)
    }
    return ok(watchStatus(window))
  })

  ipc.handle('watch:remove', (request, context) => {
    ctx.watch.unwatch(request.url)
    return ok(watchStatus(windowOf(context.sender)))
  })

  ipc.handle('watch:markSeen', (_req, context) => {
    ctx.watch.markAllSeen()
    return ok(watchStatus(windowOf(context.sender)))
  })

  // --- updates --------------------------------------------------------------

  ipc.handle('updates:status', () => ok(ctx.updates.current()))
  ipc.handle('updates:check', async () => ok(await ctx.updates.check()))

  // --- diagnostics / crash reporting ----------------------------------------

  ipc.handle('crashes:report', async () => ok(await ctx.crashes.report()))

  ipc.handle('crashes:clear', async () => {
    await ctx.crashes.clear()
    return ok(await ctx.crashes.report())
  })

  ipc.handle('crashes:openFolder', async () => {
    // Opening the folder is how a user sends a dump deliberately. Nothing is
    // uploaded for them.
    await shell.openPath(app.getPath('crashDumps'))
    return ok(undefined)
  })

  // --- ai hub ---------------------------------------------------------------

  ipc.handle('aiHub:status', () => ok(ctx.providers.status()))

  ipc.handle('aiHub:connect', (request) => {
    const error = ctx.providers.connect(request)
    return ok({ error, status: ctx.providers.status() })
  })

  ipc.handle('aiHub:disconnect', (request) => {
    ctx.providers.disconnect(request.provider)
    return ok(ctx.providers.status())
  })

  /** Resolves provider ids into live targets, skipping any not connected. */
  const comparisonTargets = (ids: readonly string[]) => {
    const status = ctx.providers.status()
    return ids.flatMap((id) => {
      const info = status.providers.find((candidate) => candidate.id === id)
      const provider = info?.connected
        ? ctx.providers.build(info.id)
        : null
      return info && provider
        ? [{ id: info.id, name: info.name, local: info.local, provider }]
        : []
    })
  }

  ipc.handle('aiHub:comparePreview', (request) => {
    const targets = comparisonTargets(request.providers)
    return ok({
      question: request.question,
      recipients: targets.map((target) => ({
        provider: target.id,
        name: target.name,
        local: target.local
      })),
      cloudCount: targets.filter((target) => !target.local).length
    })
  })

  ipc.handle('aiHub:compare', async (request) => {
    const targets = comparisonTargets(request.providers)
    if (targets.length === 0) return err('NOT_FOUND', 'None of those providers are connected')
    return ok(await ctx.comparison.run(request.question, targets))
  })

  ipc.handle('aiHub:setDefault', (request) => {
    const error = ctx.providers.setDefault(request.provider)
    return ok({ error, status: ctx.providers.status() })
  })

  // --- redirect x-ray -------------------------------------------------------

  ipc.handle('redirects:chains', (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(window.redirectRecorder.list())
  })

  ipc.handle('redirects:clear', (_req, context) => {
    windowOf(context.sender)?.redirectRecorder.clear()
    return ok(undefined)
  })

  ipc.handle('redirects:blockDomain', (request) => {
    // A bare host, appended to the user's own rules. The renderer never authors
    // filter syntax — that would be a wider surface than the feature needs.
    const host = request.host.trim().toLowerCase().replace(/^www\./, '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
      return err('VALIDATION', 'That does not look like a domain')
    }
    const existing = ctx.settings.getAll().customBlockRules
    const next = existing.includes(host) ? existing : [...existing, host]
    ctx.settings.update({ customBlockRules: next })
    ctx.blocker.refreshAllowedSites()
    return ok({ blocked: next })
  })

  // --- page insight ---------------------------------------------------------

  ipc.handle('insight:analyse', async (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(await ctx.insight.analyse(window.tabs.activeTab?.contents ?? null))
  })

  // --- cleanup mode ---------------------------------------------------------

  /** Status for the tab the user is looking at. */
  const cleanupStatus = (window: BrowserWindowController) => {
    const tab = window.tabs.activeTab
    const host = hostOf(tab?.snapshot.url ?? '')
    const settings = ctx.settings.getAll()
    return {
      active: tab ? ctx.cleanup.resultFor(tab.id) !== null : false,
      mode: settings.cleanupMode,
      host,
      disabledForHost: isDisabledForHost(host, settings.cleanupDisabledHosts),
      lastResult: tab ? ctx.cleanup.resultFor(tab.id) : null
    }
  }

  ipc.handle('cleanup:apply', async (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const tab = window.tabs.activeTab
    if (!tab) return err('NOT_FOUND', 'No tab to clean')

    const settings = ctx.settings.getAll()
    const host = hostOf(tab.snapshot.url)
    // The per-site opt-out is honoured here rather than only hidden in the UI, so
    // a menu accelerator cannot bypass what the user switched off.
    if (isDisabledForHost(host, settings.cleanupDisabledHosts)) {
      return ok({
        applied: false,
        mode: settings.cleanupMode,
        hidden: 0,
        paused: 0,
        scrollUnlocked: false,
        detail: `Cleanup is switched off for ${host}.`
      })
    }

    const mode = request.mode ?? settings.cleanupMode
    return ok(await ctx.cleanup.apply(tab.id, tab.contents, mode))
  })

  ipc.handle('cleanup:restore', async (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const tab = window.tabs.activeTab
    if (tab) await ctx.cleanup.restore(tab.id, tab.contents)
    return ok(cleanupStatus(window))
  })

  ipc.handle('cleanup:status', (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(cleanupStatus(window))
  })

  ipc.handle('cleanup:setDisabledForHost', async (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const tab = window.tabs.activeTab
    const host = hostOf(tab?.snapshot.url ?? '')
    if (host === '') return ok(cleanupStatus(window))

    const current = ctx.settings.getAll().cleanupDisabledHosts
    const already = isDisabledForHost(host, current)
    if (already !== request.disabled) {
      ctx.settings.update({ cleanupDisabledHosts: toggleHost(host, current) })
    }
    // Switching cleanup off for a site should also put the current page back,
    // or the user has turned it off and is still looking at a cleaned page.
    if (request.disabled && tab) await ctx.cleanup.restore(tab.id, tab.contents)
    return ok(cleanupStatus(window))
  })

  // --- tab brain ------------------------------------------------------------

  ipc.handle('tabBrain:analyse', (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(analyseTabs(window.tabs.allTabs().map((tab) => tab.snapshot), Date.now()))
  })

  ipc.handle('tabBrain:closeTabs', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    // Re-checked here rather than trusted from the renderer. The suggestions the
    // user saw were computed a moment ago, and a tab may have been pinned or
    // started playing audio since — in which case it is no longer closeable,
    // whatever the list said.
    const analysis = analyseTabs(window.tabs.allTabs().map((tab) => tab.snapshot), Date.now())
    const closeable = new Set(analysis.closeSuggestions.map((s) => s.tabId))
    for (const tabId of request.tabIds) {
      if (closeable.has(tabId)) window.tabs.close(tabId)
    }
    return ok(analyseTabs(window.tabs.allTabs().map((tab) => tab.snapshot), Date.now()))
  })

  ipc.handle('tabBrain:groupIntoWorkspace', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    // Never isolated. An isolated workspace owns its own cookie partition, so
    // moving tabs into one would sign them all out — a destructive surprise from
    // an action the user thinks of as tidying.
    const workspace = ctx.workspaces.create({
      name: request.name,
      icon: 'wsFolder',
      color: 'blue',
      isolated: false
    })

    let moved = 0
    for (const tabId of request.tabIds) {
      if (window.tabs.moveToWorkspace(tabId, workspace.id)) moved++
    }
    ctx.broadcastWorkspacesTo(window)
    return ok({ workspaceId: workspace.id, moved })
  })

  ipc.handle('guardian:scanDownloads', async (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(await ctx.guardian.scanDownloads(window.tabs.activeTab?.contents ?? null))
  })

  ipc.handle('guardian:scanMedia', async (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(await ctx.guardian.scanMedia(window.tabs.activeTab?.contents ?? null))
  })

  ipc.handle('downloadEngine:clearFinished', () => {
    ctx.downloadEngine.clearFinished()
    return ok(undefined)
  })

  // --- reader mode ----------------------------------------------------------

  ipc.handle('reader:open', async (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    const result = await ctx.reader.extract(window.tabs.activeTab?.contents ?? null)
    // Only opens the overlay when there is something to show. A reader view
    // containing an apology is worse than a message where the button was.
    if (result.article) window.showReader(result)
    return ok(result)
  })

  ipc.handle('reader:get', (_req, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(window.pendingReader ?? { article: null, reason: 'There is nothing to read.' })
  })

  // --- import from another browser ------------------------------------------

  ipc.handle('import:sources', () => ok(ctx.importer.discover()))

  ipc.handle('import:run', (request) => {
    const summary = ctx.importer.run(request.sourceId, {
      bookmarks: request.bookmarks,
      history: request.history
    })
    // Both lists changed underneath every open window; a panel still showing the
    // pre-import state looks like the import did nothing.
    for (const window of ctx.allWindows()) {
      ctx.ipc.broadcast('bookmarks:changed', ctx.bookmarks.list(), window.privilegedContents())
      ctx.ipc.broadcast('history:changed', {}, window.privilegedContents())
    }
    return ok(summary)
  })

  // --- ai action engine -----------------------------------------------------

  ipc.handle('ai:status', () => ok(ctx.ai.status()))

  ipc.handle('ai:setApiKey', (request) => {
    const stored = ctx.ai.setApiKey(request.key)
    return ok({
      stored,
      reason: stored
        ? null
        : 'This system has no secure credential store available, so the key was not saved. Storing it in plain text would not be acceptable.'
    })
  })

  ipc.handle('ai:egressPreview', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(buildContext(ctx, window, request.includePageContent).preview())
  })

  ipc.handle('ai:propose', async (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    const executor = new ActionExecutor(window, ctx.workspaces, ctx.bookmarks)
    const built = buildContext(ctx, window, request.includePageContent)
    const result = await ctx.ai.proposePlan(request.request, built.build(), (actions) =>
      executor.preview(actions)
    )

    if (!result.ok) {
      ctx.ai.logActivity(request.request, '', 'failed', 0, result.error)
      return ok({ plan: null, error: result.error })
    }
    ctx.ai.logActivity(
      request.request,
      result.plan.understanding,
      'proposed',
      result.plan.actions.length,
      result.plan.refusal ?? ''
    )
    return ok({ plan: result.plan, error: null })
  })

  ipc.handle('ai:approve', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    // Consumed, so a plan can run at most once — approving twice must not
    // duplicate the effects.
    const plan = ctx.ai.takePlan(request.planId)
    if (!plan) return err('NOT_FOUND', 'That plan has expired. Ask again.')

    const executor = new ActionExecutor(window, ctx.workspaces, ctx.bookmarks)
    const result = executor.execute(plan.actions)
    ctx.lastAiUndo = result.undo

    ctx.ai.logActivity(
      '',
      plan.understanding,
      'executed',
      result.applied,
      result.messages.join('; ')
    )
    ctx.broadcastWorkspacesTo(window)

    return ok({
      applied: result.applied,
      skipped: result.skipped,
      messages: result.messages,
      canUndo: result.undo !== null
    })
  })

  ipc.handle('ai:cancel', (request) => {
    const plan = ctx.ai.takePlan(request.planId)
    if (plan) ctx.ai.logActivity('', plan.understanding, 'cancelled', plan.actions.length, '')
    return ok(undefined)
  })

  ipc.handle('ai:undo', (_req, context) => {
    const undo = ctx.lastAiUndo
    if (!undo) return ok({ undone: false })
    undo()
    ctx.lastAiUndo = null
    ctx.ai.logActivity('', '', 'undone', 0, '')
    const window = windowOf(context.sender)
    if (window) ctx.broadcastWorkspacesTo(window)
    return ok({ undone: true })
  })

  ipc.handle('ai:activity', (request) => ok(ctx.ai.listActivity(request.limit)))

  // --- content blocking -----------------------------------------------------

  ipc.handle('blocking:status', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    return ok(blockingStatus(ctx, window, request.tabId))
  })

  ipc.handle('blocking:setSiteAllowed', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')

    const current = ctx.settings.getAll().blockingAllowedSites
    const next = request.allowed
      ? [...new Set([...current, request.host])]
      : current.filter((host) => host !== request.host)

    ctx.settings.update({ blockingAllowedSites: next })
    ctx.blocker.refreshAllowedSites()
    // Reload so the change takes effect on the page in front of the user rather
    // than only on the next navigation.
    window.tabs.reload(request.tabId, false)
    return ok(blockingStatus(ctx, window, request.tabId))
  })

  // --- Slash Shield ---------------------------------------------------------

  ipc.handle('shield:releasePopup', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    // The URL comes from main's own held record, keyed by this id. The renderer
    // never supplies an address, so this cannot become "open anything I name".
    if (!ctx.popups.releaseHeld(request.id)) {
      return err('NOT_FOUND', 'That popup is no longer held')
    }
    return ok(blockingStatus(ctx, window, request.tabId))
  })

  ipc.handle('shield:allowPopupsHere', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    const tab = window.tabs.findById(request.tabId)
    if (!tab) return err('NOT_FOUND', 'No such tab')
    ctx.popups.allowPopupsFor(hostOf(tab.snapshot.url))
    return ok(blockingStatus(ctx, window, request.tabId))
  })

  ipc.handle('shield:setSiteLock', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    if (request.locked) ctx.siteLockedTabs.add(request.tabId)
    else ctx.siteLockedTabs.delete(request.tabId)
    return ok(blockingStatus(ctx, window, request.tabId))
  })

  ipc.handle('shield:setMode', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    ctx.settings.update({ protectionMode: request.mode })
    return ok(blockingStatus(ctx, window, request.tabId))
  })

  ipc.handle('shield:clearActivity', (request, context) => {
    const window = windowOf(context.sender)
    if (!window) return err('NOT_FOUND', 'No window for this view')
    ctx.blocker.activity.clearAll()
    return ok(blockingStatus(ctx, window, request.tabId))
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
