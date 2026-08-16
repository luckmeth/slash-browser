import { app, BrowserWindow } from 'electron'
import { AppContext } from './AppContext'
import { parseQuery as parseQueryForDev } from './memory/parseQuery'
import { buildApplicationMenu } from './menu'
import { createLogger } from './logger'
import { prepareUserDataPath } from './userData'

const log = createLogger('main')

// Before anything reads a path, and before the single-instance lock, which is
// itself keyed off the user-data location.
prepareUserDataPath()

// A browser is a single-instance application: a second launch must hand its
// arguments to the running copy rather than open a rival process that would
// contend for the same SQLite file and session partitions.
if (!app.requestSingleInstanceLock()) {
  log.info('another instance holds the lock; exiting')
  app.quit()
} else {
  const context = new AppContext()

  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(() => {
    context.start()
    buildApplicationMenu(context)
    const window = context.createWindow()

    // Bring back what was open when the browser was last closed.
    //
    // Restored tabs are created without renderers and materialise on activation,
    // so reopening forty tabs does not launch forty processes at once. What this
    // genuinely restores is pages, order, pinning, scroll and back/forward
    // history — not logged-in state beyond what the cookies already carry.
    if (context.settings.getAll().restoreTabsOnStartup) {
      const previous = context.snapshots.latestSessionEnd()
      if (previous && previous.tabs.length > 0) {
        const restored = window.tabs.restoreFromSnapshot(previous.tabs, { activateFirst: true })
        log.info(`startup: restored ${restored} tab(s) from the previous session`)
      }
    }

    const spikePath = process.env['ADAPTIVE_SPIKE_CAPTURE']
    if (spikePath) {
      void import('./dev/spikeCapture').then(({ runSpikeCapture }) =>
        runSpikeCapture(window, spikePath)
      )
    }

    const handoffPath = process.env['SLASH_HANDOFF_CAPTURE']
    if (handoffPath) {
      void import('./dev/spikeCapture').then(({ runHandoffCapture }) =>
        runHandoffCapture(window, handoffPath)
      )
    }

    const googlePath = process.env['SLASH_GOOGLE_DIAGNOSTIC']
    if (googlePath) {
      void import('./dev/spikeCapture').then(({ runGoogleDiagnostic }) =>
        runGoogleDiagnostic(window, googlePath)
      )
    }

    if (process.env['SLASH_POPUP_PROBE']) {
      void import('./dev/spikeCapture').then(({ runPopupCapture }) =>
        runPopupCapture(window, { tabCount: () => window.tabs.allTabs().length })
      )
    }

    if (process.env['SLASH_UNSAVED_PROBE']) {
      void import('./dev/spikeCapture').then(({ runUnsavedInputCapture }) =>
        runUnsavedInputCapture(window)
      )
    }

    const blockPath = process.env['ADAPTIVE_BLOCK_CAPTURE']
    if (blockPath) {
      void import('./dev/spikeCapture').then(({ runBlockingCapture }) =>
        runBlockingCapture(window, blockPath, {
          countFor: (id) => context.blocker.countFor(id),
          diagnostics: context.blocker.diagnostics
        })
      )
    }

    const memoryPath = process.env['ADAPTIVE_MEMORY_CAPTURE']
    if (memoryPath) {
      void import('./dev/spikeCapture').then(({ runMemoryCapture }) =>
        runMemoryCapture(window, memoryPath, {
          setIndexing: (history, content) =>
            context.settings.update({ indexHistory: history, indexPageContent: content }),
          excludeOrigin: (origin) =>
            context.settings.update({
              excludedOrigins: [...context.settings.getAll().excludedOrigins, origin]
            }),
          search: (query) => ({
            results: context.memoryRepository.search(parseQueryForDev(query), 10)
          }),
          stats: () => context.memoryRepository.stats(false, false),
          clear: () => {
            context.memoryRepository.clearAll()
            context.settings.update({ excludedOrigins: [] })
          }
        })
      )
    }

    const snapshotMode = process.env['ADAPTIVE_SNAPSHOT_CAPTURE']
    if (snapshotMode) {
      void import('./dev/spikeCapture').then(({ runSnapshotCapture }) =>
        runSnapshotCapture(window, process.env['ADAPTIVE_SNAPSHOT_OUT'] ?? 'snapshot.png', snapshotMode)
      )
    }

    const permPath = process.env['ADAPTIVE_PERMISSION_CAPTURE']
    if (permPath) {
      void import('./dev/spikeCapture').then(({ runPermissionCapture }) =>
        runPermissionCapture(window, permPath, {
          respond: (requestId, policy) => context.permissions.respond(requestId, policy),
          pendingIds: () => (window.pendingPermission ? [window.pendingPermission.requestId] : [])
        })
      )
    }

    const perfPath = process.env['ADAPTIVE_PERF_CAPTURE']
    if (perfPath) {
      void import('./dev/spikeCapture').then(({ runPerformanceCapture }) =>
        runPerformanceCapture(window, perfPath)
      )
    }

    const uiPath = process.env['ADAPTIVE_UI_CAPTURE']
    if (uiPath) {
      void import('./dev/spikeCapture').then(({ runUiCapture }) =>
        runUiCapture(context, window, uiPath)
      )
    }

    app.on('activate', () => {
      if (context.windowCount === 0) context.createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * Record the session before quitting.
   *
   * `will-quit` is too late and, more importantly, synchronous — capturing scroll
   * position means asking each live renderer, which is async. So the first quit
   * is deferred: take the snapshot, then quit for real. The `quitting` flag stops
   * the second pass from deferring again and hanging the app.
   */
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void context.snapshots
      .capture('session-end')
      .catch((error: unknown) => log.error('failed to record the closing session', error))
      .finally(() => app.quit())
  })

  // `will-quit` rather than `quit`: this is the last point at which the SQLite
  // checkpoint can still run.
  app.on('will-quit', () => context.shutdown())

  process.on('uncaughtException', (error) => {
    log.error('uncaught exception in main', error)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection in main', reason)
  })
}
