import { app, crashReporter } from 'electron'
import { promises as fs } from 'node:fs'
import type { CrashEvent, CrashReport } from '@shared/types/diagnostics'
import type { Database } from '../db/Database'
import { createLogger } from '../logger'

const log = createLogger('crash')

/**
 * Local crash reporting.
 *
 * Chromium already writes a minidump when a renderer dies; without
 * `crashReporter.start()` it is simply discarded. Starting it with
 * **`uploadToServer: false`** keeps the dumps on the machine, which is the only
 * form of crash reporting this browser can honestly offer: there is no server to
 * send them to, and a browser that quietly shipped crash dumps — which contain
 * process memory, and therefore whatever was on the page — to a third party would
 * contradict everything else here.
 *
 * The user can open the folder and send a dump deliberately. That is a decision
 * they make, not a default they have to discover.
 */
export class CrashReporting {
  constructor(private readonly db: Database) {}

  /**
   * Must be called before `app.whenReady()`.
   *
   * The reporter has to be installed before any renderer exists, or the first
   * crash — often the most interesting one, during startup — is the one that
   * goes unrecorded.
   */
  static start(): void {
    crashReporter.start({
      /**
       * Empty. Nothing is ever sent, and nothing needs to be.
       *
       * Measured, so that a future reader does not repeat the experiment: with
       * `uploadToServer: false` Crashpad writes only a `metadata` file and
       * retains **no minidump**, and supplying a placeholder submit URL to coax
       * its report database into life changed nothing — both configurations
       * record zero dumps, and both start normally.
       *
       * So what this class delivers is the crash *event* — process, reason and
       * exit code, captured from Electron's process-gone handlers and verified by
       * crashing a renderer on purpose. The dump itself would need a real
       * crash-report endpoint, which is the same missing piece as the update
       * channel. The UI therefore promises the event log and not the dump.
       */
      submitURL: '',
      uploadToServer: false,
      compress: true,
      // Nothing identifying. Extra parameters are written into the dump, and a
      // dump is exactly the file we do not want carrying user data.
      ignoreSystemCrashHandler: false
    })
    log.info('crash reporter started (local dumps only, no uploads)')
  }

  /** Records a crash. Called from the process-gone handlers. */
  record(processType: string, reason: string, code: number | null): void {
    try {
      this.db.connection
        .prepare('INSERT INTO crash_events (at, process, reason, code) VALUES (?, ?, ?, ?)')
        .run(Date.now(), processType, reason, code)
      log.warn(`recorded ${processType} crash: ${reason}`)
    } catch (error) {
      // A crash record failing must never itself take the browser down.
      log.error('could not record a crash event', error)
    }
  }

  async report(): Promise<CrashReport> {
    const directory = app.getPath('crashDumps')
    let dumpCount = 0
    try {
      const entries = await fs.readdir(directory, { recursive: true })
      dumpCount = entries.filter((entry) => String(entry).endsWith('.dmp')).length
    } catch {
      // No directory yet simply means nothing has crashed.
    }

    const events = this.db.connection
      .prepare('SELECT id, at, process, reason, code FROM crash_events ORDER BY at DESC LIMIT 50')
      .all() as CrashEvent[]

    return {
      directory,
      dumpCount,
      events,
      uploadsEnabled: crashReporter.getUploadToServer?.() ?? false
    }
  }

  /** Deletes the recorded events and every dump on disk. */
  async clear(): Promise<void> {
    this.db.connection.prepare('DELETE FROM crash_events').run()
    const directory = app.getPath('crashDumps')
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        // Only inside the crash-dump directory, and only ever its contents.
        await fs.rm(`${directory}/${entry.name}`, { recursive: true, force: true })
      }
      log.info('cleared crash dumps')
    } catch (error) {
      log.warn('could not clear crash dumps', error)
    }
  }
}
