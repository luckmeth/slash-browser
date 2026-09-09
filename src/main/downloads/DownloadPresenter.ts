import { Notification, shell, type BaseWindow } from 'electron'
import { basename } from 'node:path'
import type { EngineDownload } from '@shared/types/downloadEngine'
import { createLogger } from '../logger'

const log = createLogger('downloads')

/**
 * What a download looks like from outside the Downloads panel.
 *
 * Two things, and both exist because a transfer that is only visible on a panel
 * you had to open is a transfer nobody sees:
 *
 *  - **Taskbar progress.** Windows draws it on the application's own taskbar
 *    button, which is where people look while doing something else. It is the
 *    one indicator that works when Slash is not the focused window.
 *  - **A notification per finished file, naming the file.** "Downloads
 *    finished" already existed as a *queue* notification behind an opt-in
 *    completion action; this is the ordinary per-file one every browser has,
 *    and it says which file so it is useful without opening anything.
 *
 * Failures are announced too. A download that stops with nothing said is the
 * case where somebody comes back an hour later to a file that never arrived.
 */
export class DownloadPresenter {
  /** Last known state per download, so only *transitions* are announced. */
  private readonly seen = new Map<string, EngineDownload['state']>()

  private lastFraction = -1

  constructor(
    private readonly windows: () => BaseWindow[],
    private readonly notificationsAllowed: () => boolean
  ) {}

  /**
   * Called on every change to the download list.
   *
   * Cheap on purpose: this runs on every progress tick of every transfer, so it
   * does arithmetic and two comparisons and nothing else. The taskbar is only
   * touched when the rounded value actually moves, because `setProgressBar` is
   * an IPC call to the shell and calling it sixty times a second for the same
   * number is pure cost.
   */
  update(items: readonly EngineDownload[]): void {
    this.announceFinished(items)
    this.showProgress(items)
  }

  private announceFinished(items: readonly EngineDownload[]): void {
    for (const item of items) {
      const previous = this.seen.get(item.id)
      this.seen.set(item.id, item.state)

      // Only a transition. Without this every progress tick of a completed
      // download would fire another notification.
      if (previous === undefined || previous === item.state) continue
      if (!this.notificationsAllowed()) continue
      if (!Notification.isSupported()) continue

      if (item.state === 'completed') {
        const name = item.savePath ? basename(item.savePath) : item.filename
        const notice = new Notification({
          title: 'Download complete',
          body: `${name} downloaded successfully`
        })
        // Clicking it shows the file, which is the only thing anybody wants to
        // do from this notification.
        notice.on('click', () => {
          if (item.savePath) shell.showItemInFolder(item.savePath)
        })
        notice.show()
        log.debug(`announced completion of ${name}`)
      } else if (item.state === 'failed') {
        new Notification({
          title: 'Download failed',
          // The engine's own reason, not a generic sentence — `classifyFailure`
          // already worked out whether this was a 404 or a rate limit, and
          // repeating "something went wrong" throws that away.
          body: `${item.filename} — ${item.error ?? 'the transfer stopped'}`
        }).show()
      }
    }

    // A download removed from the list should not keep a slot for ever.
    if (this.seen.size > items.length * 2 + 32) {
      const live = new Set(items.map((item) => item.id))
      for (const id of [...this.seen.keys()]) {
        if (!live.has(id)) this.seen.delete(id)
      }
    }
  }

  private showProgress(items: readonly EngineDownload[]): void {
    const live = items.filter(
      (item) => item.state === 'downloading' || item.state === 'probing'
    )

    if (live.length === 0) {
      this.setBar(-1)
      return
    }

    const total = live.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0)
    const done = live.reduce((sum, item) => sum + item.receivedBytes, 0)

    // A transfer whose length the server never reported has no percentage.
    // Windows has a state for exactly this — an indeterminate bar — and using
    // it is more honest than inventing a number that creeps to 90% and stops.
    // This is the same rule the toolbar button follows.
    this.setBar(total > 0 ? done / total : 2)
  }

  /**
   * `-1` clears, `2` is Windows' indeterminate mode, anything in `[0,1]` is a
   * proportion.
   */
  private setBar(value: number): void {
    const rounded = value < 0 || value > 1 ? value : Math.round(value * 100) / 100
    if (rounded === this.lastFraction) return
    this.lastFraction = rounded

    for (const window of this.windows()) {
      if (window.isDestroyed()) continue
      // `mode` is ignored off Windows; on macOS the value alone drives the dock
      // badge, and on Linux it depends on the desktop environment. Wrapped
      // because a shell that refuses must not take a download with it.
      try {
        window.setProgressBar(rounded === 2 ? 1 : rounded, {
          mode: rounded === 2 ? 'indeterminate' : rounded < 0 ? 'none' : 'normal'
        })
      } catch {
        // A window that cannot show progress is not a reason to stop
        // downloading.
      }
    }
  }
}
