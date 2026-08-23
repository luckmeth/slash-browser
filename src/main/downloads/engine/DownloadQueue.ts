import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type {
  DownloadPriority,
  EngineDownload,
  ServerCapabilities
} from '@shared/types/downloadEngine'
import { hostOf } from '@shared/url'
import { createLogger } from '../../logger'
import { SegmentedDownload } from './SegmentedDownload'
import {
  categorise,
  estimateSecondsRemaining,
  planConnections,
  retryDelayMs,
  safeFilename
} from './planning'

const log = createLogger('download')

/** Files transferring at once. Beyond this, everything is slower. */
const MAX_CONCURRENT = 3
/** Give up after this many attempts on one file. */
const MAX_ATTEMPTS = 4
/** Speed is averaged over this window so the figure does not flicker. */
const SPEED_WINDOW_MS = 2000

const PRIORITY_ORDER: Record<DownloadPriority, number> = { high: 0, normal: 1, low: 2 }

interface Live {
  download: SegmentedDownload
  capabilities: ServerCapabilities | null
  lastBytes: number
  lastSampleAt: number
  retryTimer: ReturnType<typeof setTimeout> | null
}

/**
 * The download queue.
 *
 * Owns every engine-driven transfer: what is running, what is waiting, what
 * failed and whether it is worth trying again. Concurrency is capped because
 * eight simultaneous files do not arrive sooner than three — they arrive at the
 * same time as each other, all late, having competed for the same bandwidth.
 *
 * Retries are automatic but bounded and backed off. A download that fails four
 * times is not going to succeed on the fifth, and a retry loop against a
 * struggling server makes us part of its problem.
 */
export class DownloadQueue {
  private readonly records = new Map<string, EngineDownload>()
  private readonly live = new Map<string, Live>()
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly defaultDirectory: () => string,
    private readonly connectionsPerFile: () => number,
    private readonly bandwidthLimit: () => number,
    private readonly onChanged: (downloads: EngineDownload[]) => void
  ) {}

  list(): EngineDownload[] {
    // Newest first — a download you just started is the one you are looking at.
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * Adds a download and starts it when there is room.
   *
   * The filename is decided here rather than after the probe so a queued item
   * has something to show immediately; a `Content-Disposition` discovered later
   * replaces it.
   */
  enqueue(
    url: string,
    options: {
      priority?: DownloadPriority
      directory?: string
      startAfter?: number | null
      /**
       * What to call the file, when the caller knows better than the URL does.
       *
       * A media URL is very often named after the endpoint rather than the
       * video — every YouTube stream is called `videoplayback` — so deriving
       * the name from the path produces a downloads folder full of identical
       * entries nobody can tell apart.
       */
      filename?: string
    } = {}
  ): string {
    const id = randomUUID()
    const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    const fallbackName = safeFilename(
      options.filename !== undefined && options.filename.trim() !== '' ? options.filename : fromUrl
    )
    const directory = options.directory ?? this.defaultDirectory()

    this.records.set(id, {
      id,
      url,
      sourceHost: hostOf(url),
      filename: fallbackName,
      savePath: join(directory, fallbackName),
      category: categorise(fallbackName, null),
      state: 'queued',
      priority: options.priority ?? 'normal',
      totalBytes: null,
      receivedBytes: 0,
      bytesPerSecond: 0,
      secondsRemaining: null,
      segments: [],
      connectionNote: options.startAfter
        ? `Scheduled for ${new Date(options.startAfter).toLocaleString()}.`
        : 'Waiting to start.',
      startAfter: options.startAfter ?? null,
      attempts: 0,
      error: null,
      startedAt: Date.now(),
      completedAt: null
    })

    this.emit()
    this.pump()
    return id
  }

  pause(id: string): void {
    const record = this.records.get(id)
    const live = this.live.get(id)
    if (!record || !live) return
    live.download.pause()
    this.patch(id, { state: 'paused', bytesPerSecond: 0, secondsRemaining: null })
    this.live.delete(id)
    this.pump()
  }

  /**
   * Continues a paused or failed download.
   *
   * Goes back through the queue rather than restarting immediately, so resuming
   * five downloads at once still honours the concurrency cap.
   */
  resume(id: string): void {
    const record = this.records.get(id)
    if (!record || record.state === 'downloading' || record.state === 'completed') return
    this.patch(id, { state: 'queued', error: null })
    this.pump()
  }

  cancel(id: string): void {
    const live = this.live.get(id)
    if (live) {
      if (live.retryTimer) clearTimeout(live.retryTimer)
      live.download.cancel()
      this.live.delete(id)
    }
    this.patch(id, { state: 'cancelled', bytesPerSecond: 0, secondsRemaining: null })
    this.pump()
  }

  /** Forgets a finished download. The file on disk is left alone. */
  remove(id: string): void {
    if (this.live.has(id)) this.cancel(id)
    this.records.delete(id)
    this.emit()
  }

  clearFinished(): void {
    for (const [id, record] of this.records) {
      if (record.state === 'completed' || record.state === 'cancelled' || record.state === 'failed') {
        this.records.delete(id)
      }
    }
    this.emit()
  }

  setPriority(id: string, priority: DownloadPriority): void {
    this.patch(id, { priority })
    this.pump()
  }

  /** Stops everything, for shutdown. Partial files stay on disk. */
  dispose(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer)
    this.scheduleTimer = null
    for (const [id, live] of this.live) {
      if (live.retryTimer) clearTimeout(live.retryTimer)
      live.download.pause()
      if (this.records.has(id)) this.patch(id, { state: 'paused' })
    }
    this.live.clear()
  }

  /** Starts whatever is waiting, in priority then arrival order. */
  private pump(): void {
    if (this.live.size >= MAX_CONCURRENT) return

    const now = Date.now()
    const queued = [...this.records.values()].filter((record) => record.state === 'queued')

    // A scheduled download is queued but not yet eligible. One timer is armed
    // for the earliest due time rather than polling: a queue holding a transfer
    // for six hours must not wake up every second to check.
    const held = queued.filter((record) => record.startAfter !== null && record.startAfter > now)
    if (held.length > 0) this.armScheduleTimer(held)

    const next = queued
      .filter((record) => record.startAfter === null || record.startAfter <= now)
      .sort(
        (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.startedAt - b.startedAt
      )[0]

    if (!next) return
    void this.begin(next.id)
    // More slots may be free; keep filling until the cap or the queue is empty.
    if (this.live.size < MAX_CONCURRENT) this.pump()
  }

  /** Arms a single timer for the soonest scheduled download. */
  private armScheduleTimer(held: readonly EngineDownload[]): void {
    const soonest = Math.min(...held.map((record) => record.startAfter ?? Number.MAX_SAFE_INTEGER))
    if (!Number.isFinite(soonest)) return
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer)
    this.scheduleTimer = setTimeout(
      () => {
        this.scheduleTimer = null
        this.pump()
      },
      Math.max(250, soonest - Date.now())
    )
  }

  /** Starts a scheduled download now, ignoring its hold. */
  startNow(id: string): void {
    this.patch(id, { startAfter: null, state: 'queued' })
    this.pump()
  }

  private async begin(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return

    const download = new SegmentedDownload({
      url: record.url,
      destination: record.savePath,
      connections: this.connectionsPerFile(),
      bandwidthLimit: this.bandwidthLimit(),
      onProgress: (received, segments) => this.onProgress(id, received, segments)
    })

    const live: Live = {
      download,
      capabilities: null,
      lastBytes: 0,
      lastSampleAt: Date.now(),
      retryTimer: null
    }
    this.live.set(id, live)
    this.patch(id, { state: 'probing', attempts: record.attempts + 1, error: null })

    try {
      const capabilities = await download.probe()
      live.capabilities = capabilities

      // The server may name the file better than the URL did.
      const filename = capabilities.suggestedName ?? record.filename
      const savePath = await this.uniquePath(join(this.defaultDirectory(), filename))
      const plan = planConnections(capabilities, this.connectionsPerFile())

      this.patch(id, {
        filename,
        savePath,
        category: categorise(filename, capabilities.mimeType),
        totalBytes: capabilities.totalBytes,
        connectionNote: plan.note,
        state: 'downloading'
      })

      // The destination may have changed after the probe, so the transfer runs
      // against a downloader built with the final path.
      const finalDownload = new SegmentedDownload({
        url: record.url,
        destination: savePath,
        connections: plan.connections,
        bandwidthLimit: this.bandwidthLimit(),
        onProgress: (received, segments) => this.onProgress(id, received, segments)
      })
      live.download = finalDownload

      await finalDownload.run(capabilities.totalBytes, plan.connections)

      // A paused transfer resolves the same way a finished one does; only the
      // byte count distinguishes them.
      const current = this.records.get(id)
      if (!current || current.state === 'cancelled') return
      if (current.state === 'paused') {
        this.live.delete(id)
        this.pump()
        return
      }

      this.patch(id, {
        state: 'completed',
        receivedBytes: capabilities.totalBytes ?? finalDownload.receivedBytes,
        bytesPerSecond: 0,
        secondsRemaining: 0,
        completedAt: Date.now()
      })
      log.info(`downloaded ${filename} from ${record.sourceHost}`)
      this.live.delete(id)
      this.pump()
    } catch (error) {
      this.live.delete(id)
      this.fail(id, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Records a failure and schedules a retry if one is worth making.
   *
   * Bounded on purpose: four attempts is enough to ride out a dropped
   * connection, and past that the fault is not transient.
   */
  private fail(id: string, message: string): void {
    const record = this.records.get(id)
    if (!record || record.state === 'cancelled') return

    if (record.attempts >= MAX_ATTEMPTS) {
      this.patch(id, { state: 'failed', error: message, bytesPerSecond: 0, secondsRemaining: null })
      log.warn(`download failed after ${record.attempts} attempts: ${message}`)
      this.pump()
      return
    }

    const delay = retryDelayMs(record.attempts)
    this.patch(id, {
      state: 'queued',
      error: `${message} — retrying in ${Math.round(delay / 1000)}s`,
      bytesPerSecond: 0
    })
    setTimeout(() => {
      const current = this.records.get(id)
      if (current?.state === 'queued') this.pump()
    }, delay)
  }

  private onProgress(id: string, received: number, segments: readonly { index: number; start: number; end: number; receivedBytes: number }[]): void {
    const record = this.records.get(id)
    const live = this.live.get(id)
    if (!record || !live) return

    const now = Date.now()
    const elapsed = now - live.lastSampleAt
    // Sampled rather than computed per chunk: a rate derived from a single 16 KB
    // write swings wildly and is unreadable.
    if (elapsed < SPEED_WINDOW_MS) {
      record.receivedBytes = received
      record.segments = segments.map((segment) => ({ ...segment }))
      return
    }

    const bytesPerSecond = Math.max(0, Math.round(((received - live.lastBytes) * 1000) / elapsed))
    live.lastBytes = received
    live.lastSampleAt = now

    this.patch(id, {
      receivedBytes: received,
      segments: segments.map((segment) => ({ ...segment })),
      bytesPerSecond,
      secondsRemaining: estimateSecondsRemaining(record.totalBytes, received, bytesPerSecond)
    })
  }

  /** Never overwrite an existing file: "report.pdf" becomes "report (1).pdf". */
  private async uniquePath(candidate: string): Promise<string> {
    const dot = candidate.lastIndexOf('.')
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate
    const extension = dot > 0 ? candidate.slice(dot) : ''

    for (let attempt = 0; attempt < 200; attempt++) {
      const path = attempt === 0 ? candidate : `${stem} (${attempt})${extension}`
      try {
        await fs.access(path)
      } catch {
        return path
      }
    }
    return `${stem} (${Date.now()})${extension}`
  }

  private patch(id: string, update: Partial<EngineDownload>): void {
    const record = this.records.get(id)
    if (!record) return
    this.records.set(id, { ...record, ...update })
    this.emit()
  }

  private emit(): void {
    this.onChanged(this.list())
  }
}
