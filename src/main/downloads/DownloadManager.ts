import { join } from 'node:path'
import { app, dialog, shell, type BaseWindow, type Session, type DownloadItem as ElectronDownloadItem } from 'electron'
import { isDangerousFilename, type DownloadItem, type DownloadState } from '@shared/types/browsing'
import type { DownloadRepository } from '../db/repositories/DownloadRepository'
import type { SettingsStore } from '../settings/SettingsStore'
import { createLogger } from '../logger'

const log = createLogger('downloads')

/** Progress writes are throttled to this interval to avoid hammering SQLite. */
const PERSIST_INTERVAL_MS = 1000
/** UI updates are cheap but not free; one every quarter second reads as smooth. */
const BROADCAST_INTERVAL_MS = 250

let counter = 0

export interface DownloadHooks {
  onChanged: (items: DownloadItem[]) => void
  /** Window used to parent modal dialogs. */
  getWindow: () => BaseWindow | null
}

export class DownloadManager {
  private readonly live = new Map<string, ElectronDownloadItem>()
  private readonly items = new Map<string, DownloadItem>()
  /**
   * WebContents that started each in-flight download.
   *
   * Used by the performance engine's `active-download` guard. Scoped to the
   * initiating tab rather than blocking every tab: one download should not keep
   * a hundred unrelated tabs from sleeping.
   */
  private readonly initiators = new Map<string, number>()
  private lastPersist = new Map<string, number>()
  private broadcastTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly repository: DownloadRepository,
    private readonly settings: SettingsStore,
    private readonly hooks: DownloadHooks
  ) {}

  /**
   * Loads persisted downloads and reconciles anything left mid-transfer.
   *
   * Electron cannot resume a download whose process has exited — the request is
   * gone with it — so a row still marked `progressing` from a previous run would
   * otherwise sit in the list forever showing a bar that never moves.
   */
  restore(): void {
    const reconciled = this.repository.reconcileInterrupted()
    if (reconciled > 0) log.info(`marked ${reconciled} unfinished download(s) as interrupted`)
    for (const item of this.repository.list()) this.items.set(item.id, item)
  }

  attachToSession(target: Session): void {
    target.on('will-download', (_event, electronItem, webContents) => {
      counter += 1
      const id = `dl-${Date.now().toString(36)}-${counter.toString(36)}`
      const filename = electronItem.getFilename()
      if (webContents && !webContents.isDestroyed()) this.initiators.set(id, webContents.id)

      const settings = this.settings.getAll()
      if (!settings.askWhereToSaveDownloads) {
        const directory = settings.downloadDirectory || app.getPath('downloads')
        // Setting a path suppresses Electron's own save dialog. Leaving it unset
        // is what makes "ask every time" work.
        electronItem.setSavePath(join(directory, filename))
      }

      const item: DownloadItem = {
        id,
        url: electronItem.getURL(),
        filename,
        savePath: electronItem.getSavePath(),
        mimeType: electronItem.getMimeType(),
        totalBytes: electronItem.getTotalBytes() || -1,
        receivedBytes: 0,
        state: 'progressing',
        isDangerous: isDangerousFilename(filename),
        startedAt: Date.now(),
        completedAt: null
      }

      this.live.set(id, electronItem)
      this.items.set(id, item)
      this.repository.upsert(item)
      this.broadcast(true)

      electronItem.on('updated', (_e, state) => {
        this.update(id, {
          receivedBytes: electronItem.getReceivedBytes(),
          totalBytes: electronItem.getTotalBytes() || -1,
          savePath: electronItem.getSavePath(),
          state: state === 'interrupted' ? 'interrupted' : electronItem.isPaused() ? 'paused' : 'progressing'
        })
      })

      electronItem.once('done', (_e, state) => {
        this.live.delete(id)
        this.initiators.delete(id)
        this.update(
          id,
          {
            receivedBytes: electronItem.getReceivedBytes(),
            savePath: electronItem.getSavePath(),
            state: state as DownloadState,
            completedAt: Date.now()
          },
          true
        )
        log.info(`download ${state}: ${filename}`)
      })
    })
  }

  list(): DownloadItem[] {
    return [...this.items.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Whether the given WebContents has a download still running. */
  hasActiveDownloadFrom(webContentsId: number): boolean {
    for (const [id, initiatorId] of this.initiators) {
      if (initiatorId !== webContentsId) continue
      const item = this.items.get(id)
      if (item && (item.state === 'progressing' || item.state === 'paused')) return true
    }
    return false
  }

  /**
   * Where downloads are saved right now.
   *
   * Shared with the segmented engine so both paths land in the same folder —
   * two download systems writing to two different places would be its own bug.
   */
  directory(): string {
    return this.settings.getAll().downloadDirectory || app.getPath('downloads')
  }

  pause(id: string): void {
    this.live.get(id)?.pause()
  }

  resume(id: string): void {
    const item = this.live.get(id)
    if (item?.canResume()) item.resume()
  }

  cancel(id: string): void {
    this.live.get(id)?.cancel()
  }

  /**
   * Opens a completed download.
   *
   * Executable files get a confirmation first. This is a caution, not a security
   * boundary — it cannot tell a malicious document from a benign one, and the
   * wording deliberately does not imply that an unflagged file is safe.
   */
  async openFile(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item || item.state !== 'completed') return

    if (item.isDangerous && this.settings.getAll().warnOnExecutableDownload) {
      const window = this.hooks.getWindow()
      const options = {
        type: 'warning' as const,
        buttons: ['Open anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Open downloaded file?',
        message: `"${item.filename}" can run code on your computer.`,
        detail:
          `It was downloaded from ${originOf(item.url)}.\n\n` +
          `Only open it if you trust that source. This warning is based on the file ` +
          `extension alone — it cannot tell whether this particular file is harmful.`,
        noLink: true
      }
      const { response } = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
      if (response !== 0) return
    }

    const error = await shell.openPath(item.savePath)
    if (error) log.error(`could not open ${item.savePath}: ${error}`)
  }

  showInFolder(id: string): void {
    const item = this.items.get(id)
    if (item) shell.showItemInFolder(item.savePath)
  }

  /** Removes from the list only. The file on disk is left alone. */
  remove(id: string): void {
    this.live.get(id)?.cancel()
    this.live.delete(id)
    this.items.delete(id)
    this.repository.remove(id)
    this.broadcast(true)
  }

  clearCompleted(): void {
    for (const [id, item] of this.items) {
      if (item.state !== 'progressing' && item.state !== 'paused') this.items.delete(id)
    }
    this.repository.clearCompleted()
    this.broadcast(true)
  }

  private update(id: string, patch: Partial<DownloadItem>, force = false): void {
    const existing = this.items.get(id)
    if (!existing) return
    const next = { ...existing, ...patch }
    this.items.set(id, next)

    const now = Date.now()
    const lastWrite = this.lastPersist.get(id) ?? 0
    if (force || now - lastWrite >= PERSIST_INTERVAL_MS) {
      this.repository.upsert(next)
      this.lastPersist.set(id, now)
    }
    this.broadcast(force)
  }

  private broadcast(immediate: boolean): void {
    if (immediate) {
      if (this.broadcastTimer) {
        clearTimeout(this.broadcastTimer)
        this.broadcastTimer = null
      }
      this.hooks.onChanged(this.list())
      return
    }
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.hooks.onChanged(this.list())
    }, BROADCAST_INTERVAL_MS)
  }

  dispose(): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer)
    this.broadcastTimer = null
    // Persist final state for anything still running before the DB closes.
    for (const item of this.items.values()) this.repository.upsert(item)
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
