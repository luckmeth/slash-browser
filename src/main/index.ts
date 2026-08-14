import { app, BrowserWindow } from 'electron'
import { AppContext } from './AppContext'
import { buildApplicationMenu } from './menu'
import { createLogger } from './logger'

const log = createLogger('main')

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

    const spikePath = process.env['ADAPTIVE_SPIKE_CAPTURE']
    if (spikePath) {
      void import('./dev/spikeCapture').then(({ runSpikeCapture }) =>
        runSpikeCapture(window, spikePath)
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
