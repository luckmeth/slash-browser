import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type {
  DownloadPriority,
  EngineDownload,
  EngineDownloadState,
  EngineDownloadStore,
  PersistedDownload,
  ServerCapabilities
} from '@shared/types/downloadEngine'
import { hostOf } from '@shared/url'
import { createLogger } from '../../logger'
import { planStream, StreamDownload } from './StreamDownload'
import type { MediaRequestContext } from './requestContext'
import { backoffMs, cancellableDelay, classifyFailure } from './retryPolicy'
import { isExpiringMediaHost, mediaUrlHasExpired } from '../../media/mediaSniffing'
import { folderForCategory } from './categoryFolders'
import { shouldFire, type CompletionAction } from './completionAction'
import { refreshVerdict } from './linkRefresh'
import {
  DEFAULT_QUEUES,
  DEFAULT_QUEUE_ID,
  selectStartable,
  type QueueDefinition
} from './queuePlanning'
import { confinedPath } from './paths'
import type { Segment } from '@shared/types/downloadEngine'
import { Muxer } from './Muxer'
import { SegmentedDownload } from './SegmentedDownload'
import {
  canContinue,
  categorise,
  estimateSecondsRemaining,
  planConnections,
  recoveredState,
  resumePlan,
  safeFilename, isStreamUrl, withExtension
} from './planning'

const log = createLogger('download')

/** Files transferring at once. Beyond this, everything is slower. */
const MAX_CONCURRENT = 3
/** Give up after this many attempts on one file. */
const MAX_ATTEMPTS = 4
/** Speed is averaged over this window so the figure does not flicker. */
const SPEED_WINDOW_MS = 2000
/**
 * How often a moving download is checkpointed to disk.
 *
 * Progress arrives several times a second per connection; state changes are
 * written immediately regardless. One second is the same trade `DownloadManager`
 * makes for Chromium's downloads, and for the same reason: the value is only
 * ever read on the next launch.
 */
const PERSIST_INTERVAL_MS = 1000


/** Everything needed to continue a paused transfer where it stopped. */
interface SuspendedDownload {
  /** What the server said when the transfer began — the resume check needs it. */
  readonly capabilities: ServerCapabilities
  /** The segment table as it stood, byte counts included. */
  readonly segments: Segment[]
  /** The file already partly written. Never re-derived, or it would move. */
  readonly savePath: string
}

interface Live {
  /** Absent when the source is a stream, which downloads a different way. */
  download?: SegmentedDownload
  /** Set instead of `download` when the source is a stream rather than a file. */
  stream?: StreamDownload
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
  /** Joins a video stream to its audio. Absent ffmpeg means it reports so. */
  private readonly muxer = new Muxer()
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * When each download was last written down.
   *
   * Progress arrives several times a second per connection. Writing every one
   * would put SQLite in the transfer's hot path for a value nobody reads until
   * the next launch — so a moving download is checkpointed on a timer, and
   * every state *change* is written immediately regardless.
   */
  private readonly lastPersisted = new Map<string, number>()
  /** Downloads that must never be written down: private-window transfers. */
  private readonly ephemeral = new Set<string>()

  constructor(
    private readonly defaultDirectory: () => string,
    private readonly connectionsPerFile: () => number,
    private readonly bandwidthLimit: () => number,
    private readonly onChanged: (downloads: EngineDownload[]) => void,
    /**
     * Where downloads are written down, when there is anywhere to write them.
     *
     * Optional because the engine is a thing that downloads files, not a thing
     * that needs a database: every probe and test constructs it without one,
     * and a queue with no store simply does not survive a restart — which is
     * exactly what it did before.
     */
    private readonly store?: EngineDownloadStore,
    /**
     * The named queues, read fresh each time rather than captured.
     *
     * A getter because they live in settings: pausing a queue has to take
     * effect on the next pump, not on the next restart.
     */
    private readonly queues: () => QueueDefinition[] = () => DEFAULT_QUEUES,
    private readonly sortByCategory: () => boolean = () => false,
    /** Fires once nothing is left to run. See `shouldFire`. */
    private readonly onAllComplete?: (action: CompletionAction) => void,
    private readonly completionAction: () => CompletionAction = () => 'nothing'
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
      /** Named queue to run in. Defaults to the main one. */
      queue?: string
      /**
       * What to call the file, when the caller knows better than the URL does.
       *
       * A media URL is very often named after the endpoint rather than the
       * video — every YouTube stream is called `videoplayback` — so deriving
       * the name from the path produces a downloads folder full of identical
       * entries nobody can tell apart.
       */
      filename?: string
      /**
       * Audio stream to join to this one when it finishes.
       *
       * Taken here rather than registered by the caller afterwards, and that is
       * not a style choice: `enqueue` ends with `pump()`, which can reach
       * `begin` synchronously — so a pairing recorded on the line *after*
       * enqueue arrives too late, and the download runs as a plain single file.
       * It downloads, it completes, and the video is silent. Found by running it.
       */
      joinWith?: string
      /**
       * The page this came from: session, cookies, referrer, user agent.
       *
       * Kept in a side map rather than on the record, because the record is
       * broadcast over IPC and a `Session` is not serialisable — and because
       * nothing in the renderer has any business seeing it.
       */
      context?: MediaRequestContext
      /**
       * What the master playlist said about a chosen quality.
       *
       * Only reaches the size estimate. A variant playlist does not restate its
       * own bitrate, so without this a quality picked from the list downloads
       * with no size at all — which reads as the download not knowing what it
       * is doing.
       */
      streamHint?: { bandwidth?: number; quality?: string | null }
      /**
       * This address is a playlist, whatever it looks like.
       *
       * `isStreamUrl` reads the path, and a great many CDNs serve HLS from a
       * path with no extension at all — `…/hls/1080/<id>/<id>/<n>/<hash>` is a
       * real one. The sniffer already knew: it classified that response as a
       * stream from its `Content-Type`. Re-deriving the answer from the URL
       * threw that knowledge away and sent the playlist down the file path,
       * where it "downloaded" successfully as a few kilobytes of text that no
       * player will open. Told rather than guessed, when the caller knows.
       */
      isStream?: boolean
    } = {}
  ): string {
    const id = randomUUID()
    const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    const fallbackName = safeFilename(
      options.filename !== undefined && options.filename.trim() !== '' ? options.filename : fromUrl
    )
    // Category first, because it decides the folder. Sorting is off by default,
    // in which case this is the base directory unchanged.
    const category = categorise(fallbackName, null)
    const directory = folderForCategory(
      options.directory ?? this.defaultDirectory(),
      category,
      this.sortByCategory()
    )

    this.records.set(id, {
      id,
      url,
      sourceHost: hostOf(url),
      filename: fallbackName,
      savePath: join(directory, fallbackName),
      category,
      state: 'queued',
      priority: options.priority ?? 'normal',
      queue: options.queue ?? DEFAULT_QUEUE_ID,
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

    // Before pump(), which may start the download immediately. Both of these
    // are read inside `begin`, so recording them on the line after `enqueue`
    // returns is already too late — see the note on `joinWith`.
    if (options.joinWith !== undefined) this.pairs.set(id, options.joinWith)
    if (options.context !== undefined) this.contexts.set(id, options.context)
    if (options.streamHint !== undefined) this.hints.set(id, options.streamHint)
    if (options.isStream === true) this.streams.add(id)
    // The *resolved* directory, not the requested one: with category sorting on
    // they differ, and `begin` reads this back to decide where the file goes.
    this.directories.set(id, directory)
    // A private window's session is in-memory by construction. A row describing
    // one of its downloads would outlive the window that was promised to leave
    // no trace, so those are never written down.
    if (options.context?.partition === 'private') this.ephemeral.add(id)

    // A new download means the queue is no longer finished, so the "everything
    // is done" action is armed again. Without this, adding one more file after
    // a batch completed would never fire it.
    this.completionFired = false
    this.emit()
    this.pump()
    return id
  }

  /**
   * One download that is really two: a video stream and its separate audio.
   *
   * Every adaptive site above about 720p sends them apart. This keeps the fact
   * out of the user's way — **one entry in the list**, one progress bar, one
   * file at the end — because "your video is in two pieces, here is a tool" is
   * an implementation detail leaking into somebody's downloads folder.
   *
   * Falls back to keeping both parts if the join fails or ffmpeg is absent, and
   * says so. Two files that play beat one error where a download should be.
   */
  enqueueJoined(
    videoUrl: string,
    audioUrl: string,
    options: { filename: string; priority?: DownloadPriority; context?: MediaRequestContext } = {
      filename: 'video.mp4'
    }
  ): string {
    return this.enqueue(videoUrl, {
      priority: options.priority ?? 'normal',
      startAfter: null,
      filename: options.filename,
      joinWith: audioUrl,
      context: options.context
    })
  }

  /** Audio stream to join, for downloads that are two streams. */
  private readonly pairs = new Map<string, string>()
  /**
   * Where each download came from, so its requests look like the page's own.
   *
   * Survives a retry, which is the point of keying it by id rather than passing
   * it into `begin`: a media download that fails once and is retried without
   * its referrer fails the second time for a different reason than the first.
   */
  private readonly contexts = new Map<string, MediaRequestContext>()
  /** Bitrate and resolution a master playlist declared for a chosen variant. */
  private readonly hints = new Map<string, { bandwidth?: number; quality?: string | null }>()
  /** Downloads the caller told us are playlists, whatever their address says. */
  private readonly streams = new Set<string>()
  /**
   * Where each download was told to go, when the user chose.
   *
   * Kept per download rather than read from settings at write time: somebody
   * who picks a folder for one file and then changes the default has not asked
   * for the running transfer to move.
   */
  private readonly directories = new Map<string, string>()
  /** Cancellers for transfers another process is running. */
  private readonly external = new Map<string, () => void>()
  /**
   * What a paused download left on disk, so it can be continued rather than
   * started again.
   *
   * Captured **after** the transfer's promise settles, not inside `pause()`:
   * pausing aborts the in-flight requests, and the last few chunks are written
   * and counted as those loops unwind. Reading the segment table a moment too
   * early records a byte count lower than what is actually on disk, and resuming
   * from it re-fetches a range that is already there — which is harmless, and
   * exactly the kind of harmless that hides a real off-by-one.
   */
  private readonly suspended = new Map<string, SuspendedDownload>()
  /**
   * The path each download settled on, kept for its whole life.
   *
   * `uniquePath` refuses to overwrite an existing file, which is right the
   * first time and wrong every time after: on resume — and on every automatic
   * retry — the download's own partial file is what it collides with, so the
   * destination became `film (1).mp4`, then `film (2).mp4`, each one started
   * from zero. The path is chosen once and reused.
   */
  private readonly chosenPaths = new Map<string, string>()

  /**
   * Whether joining two streams is possible in this build.
   *
   * False when ffmpeg was not fetched before packaging. The picker asks before
   * promising a single file, because offering one and delivering two is worse
   * than offering two.
   */
  canJoin(): boolean {
    return this.muxer.available()
  }

  pause(id: string): void {
    const record = this.records.get(id)
    const live = this.live.get(id)
    if (!record || !live) return

    // A stream cannot be paused and resumed: there is no byte offset to come
    // back to, only a position in a list of segments and a part-written file
    // that is not a valid video. Pausing one would offer a Resume that
    // restarted it from nothing, so it is refused rather than mimed.
    if (live.stream) {
      this.patch(id, { connectionNote: 'A joined stream cannot be paused — cancel and start again.' })
      return
    }
    live.download?.pause()
    this.patch(id, { state: 'paused', bytesPerSecond: 0, secondsRemaining: null })
    // The entry stays live on purpose. Pausing only *asks* the transfer to
    // stop: its segment loops are sleeping on the bandwidth throttle and take
    // a moment to notice, and the partial state cannot be captured until they
    // have. Releasing the slot here let a quick Resume start a second transfer
    // over the top of the first — which then restarted the whole file, and
    // deleted the new transfer's own live entry as it finally unwound.
    // The continuation in `begin` captures the bytes, frees the slot and pumps.
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
    // An adopted transfer is not ours to abort — it belongs to another process.
    // Ask it to stop and let its own completion handler settle the record.
    const external = this.external.get(id)
    if (external) {
      external()
      this.external.delete(id)
    }

    const live = this.live.get(id)
    if (live) {
      if (live.retryTimer) clearTimeout(live.retryTimer)
      live.download?.cancel()
      live.stream?.cancel()
      this.live.delete(id)
    }
    this.patch(id, { state: 'cancelled', bytesPerSecond: 0, secondsRemaining: null })
    this.pump()
  }

  /**
   * Takes a transfer another program is running and shows it in this list.
   *
   * Adopted rather than executed: the bytes are somebody else's business, and
   * nothing here probes, segments, retries or resumes it. What this provides is
   * the one thing that matters to the person watching — the download appears in
   * the same list as every other, with the same progress bar and the same Open
   * and Show in folder, instead of happening invisibly somewhere else.
   *
   * Deliberately never queued. `pump` schedules work this engine performs, and
   * an external tool has already started by the time it is handed over; putting
   * it in the queue would either double-start it or hold it behind downloads it
   * knows nothing about.
   */
  adoptExternal(options: {
    url: string
    filename: string
    directory: string
    connectionNote: string
    onCancel: () => void
  }): {
    id: string
    progress: (received: number, total: number | null, bytesPerSecond: number) => void
    finish: (result: { ok: boolean; error: string | null; file: string | null }) => void
  } {
    const id = randomUUID()
    const filename = safeFilename(options.filename)

    this.records.set(id, {
      id,
      url: options.url,
      sourceHost: hostOf(options.url),
      filename,
      savePath: join(options.directory, filename),
      category: categorise(filename, null),
      state: 'downloading',
      priority: 'normal',
      queue: DEFAULT_QUEUE_ID,
      totalBytes: null,
      receivedBytes: 0,
      bytesPerSecond: 0,
      secondsRemaining: null,
      segments: [],
      connectionNote: options.connectionNote,
      startAfter: null,
      attempts: 0,
      error: null,
      startedAt: Date.now(),
      completedAt: null
    })
    this.external.set(id, options.onCancel)
    this.completionFired = false
    this.emit()

    return {
      id,
      progress: (received, total, bytesPerSecond) => {
        if (this.records.get(id)?.state !== 'downloading') return
        this.patch(id, {
          receivedBytes: received,
          totalBytes: total,
          bytesPerSecond,
          secondsRemaining: estimateSecondsRemaining(total, received, bytesPerSecond)
        })
      },
      finish: (result) => {
        this.external.delete(id)
        const record = this.records.get(id)
        // Cancelled while it ran; `cancel` already settled the record and
        // overwriting it here would resurrect a row the user dismissed.
        if (!record || record.state === 'cancelled') return

        if (!result.ok) {
          this.patch(id, {
            state: 'failed',
            error: result.error ?? 'The external downloader stopped.',
            bytesPerSecond: 0,
            secondsRemaining: null
          })
          this.emit()
          return
        }

        this.patch(id, {
          state: 'completed',
          // The path the tool printed once the file had landed. It chooses the
          // final name — the title decides it and the tool sanitises it — so
          // anything derived here would point at a file that is not there.
          savePath: result.file ?? record.savePath,
          filename: result.file ? (result.file.split(/[\\/]/).pop() ?? filename) : filename,
          bytesPerSecond: 0,
          secondsRemaining: null,
          completedAt: Date.now(),
          error: null
        })
        this.emit()
      }
    }
  }

  /** Forgets a finished download. The file on disk is left alone. */
  remove(id: string): void {
    if (this.live.has(id)) this.cancel(id)
    this.records.delete(id)
    this.store?.remove(id)
    this.forget(id)
    this.emit()
  }

  /** Drops the side tables a finished download no longer needs. */
  private forget(id: string): void {
    this.pairs.delete(id)
    this.contexts.delete(id)
    this.hints.delete(id)
    this.streams.delete(id)
    this.suspended.delete(id)
    this.chosenPaths.delete(id)
    this.lastPersisted.delete(id)
    this.ephemeral.delete(id)
    this.directories.delete(id)
  }

  clearFinished(): void {
    for (const [id, record] of this.records) {
      if (record.state === 'completed' || record.state === 'cancelled' || record.state === 'failed') {
        this.records.delete(id)
        this.forget(id)
      }
    }
    this.store?.clearFinished()
    this.emit()
  }

  /**
   * Moves a download to another queue.
   *
   * Only meaningful before it starts, and deliberately not enforced: moving a
   * running download changes which queue it counts against the moment it next
   * stops, which is what somebody reorganising a full list expects. Nothing is
   * cancelled and no bytes are thrown away.
   */
  setQueue(id: string, queue: string): void {
    const record = this.records.get(id)
    if (!record) return
    this.patch(id, { queue })
    this.pump()
  }

  /**
   * Points a download at a new address without losing what it has.
   *
   * Media CDNs expire their links after a few hours, so a transfer paused
   * overnight comes back to a 403 with a perfectly good half-file beside it.
   * Re-adding the download would start from zero; this keeps the partial when
   * - and only when - the new address proves it serves the same bytes.
   *
   * `refreshVerdict` makes that decision and is where the risk lives: continuing
   * a partial from a *different* file splices two videos into one that plays,
   * briefly, and is wrong. A matching length alone is never enough for that.
   */
  async refreshUrl(id: string, url: string): Promise<{ ok: boolean; reason: string }> {
    const record = this.records.get(id)
    if (!record) return { ok: false, reason: 'That download is no longer in the list.' }
    if (this.live.has(id)) {
      return { ok: false, reason: 'Pause the download before changing its address.' }
    }

    const previous = this.suspended.get(id)?.capabilities ?? null
    const probe = new SegmentedDownload({
      url,
      destination: record.savePath,
      connections: 1,
      context: this.contexts.get(id),
      onProgress: () => {}
    })

    let next: ServerCapabilities
    try {
      next = await probe.probe()
    } catch (error) {
      return {
        ok: false,
        reason: `That address did not answer: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const verdict = previous === null
      ? { continueFromPartial: false, usable: true, reason: 'Starting from the beginning.' }
      : refreshVerdict(previous, next)

    if (!verdict.usable) return { ok: false, reason: verdict.reason }

    const partial = this.suspended.get(id)
    if (verdict.continueFromPartial && partial) {
      this.suspended.set(id, { ...partial, capabilities: next })
    } else {
      this.suspended.delete(id)
      this.patch(id, { receivedBytes: 0, segments: [] })
    }

    this.patch(id, {
      url,
      sourceHost: hostOf(url),
      state: 'queued',
      error: null,
      attempts: 0,
      connectionNote: verdict.reason
    })
    this.pump()
    return { ok: true, reason: verdict.reason }
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
      live.download?.pause()
      // A stream in flight is stopped rather than paused: there is nothing to
      // resume from, and leaving it marked paused would offer a Resume that
      // silently started again from nothing on the next launch.
      live.stream?.cancel()
      if (this.records.has(id)) {
        this.patch(id, { state: live.stream ? 'cancelled' : 'paused' })
      }
    }
    this.live.clear()
  }

  /**
   * Rebuilds the queue from what was written down before the last quit.
   *
   * ## Nothing starts by itself
   *
   * A download that was *transferring* when the browser exited comes back
   * **paused**, not downloading. The browser did not decide to stop it, but it
   * did stop, and silently resuming several large transfers the moment somebody
   * opens their browser is a decision to spend their bandwidth without asking.
   * `queued` and `scheduled` come back as they were, because those were already
   * instructions to start.
   *
   * ## What it verifies before offering to continue
   *
   * A restored download is only resumable if the server offered a validator, if
   * the segment table adds up to the file, and if the partial file is still
   * where it was. Any of those failing is not an error — it means the download
   * starts again from the beginning, into the same path, which is what would
   * have happened anyway.
   *
   * The session is looked up by partition **name**, so cookies come from
   * Chromium's own jar rather than from anything we stored.
   */
  restore(
    saved: readonly PersistedDownload[],
    sessionFor: (partition: string) => Electron.Session | null = () => null
  ): { restored: number; resumable: number } {
    let resumable = 0

    for (const entry of saved) {
      const { record } = entry
      // Whatever was in flight is not in flight any more. The rule itself lives
      // in `planning` so it is testable without a database or a network.
      const state: EngineDownloadState = recoveredState(record.state)

      this.records.set(record.id, {
        ...record,
        state,
        bytesPerSecond: 0,
        secondsRemaining: null,
        connectionNote:
          state === 'paused' && record.state !== 'paused'
            ? 'Interrupted when Slash closed. Resume to continue from where it stopped.'
            : record.connectionNote
      })

      // The destination is already decided; re-deriving it would collide with
      // this download's own partial file and rename it.
      this.chosenPaths.set(record.id, record.savePath)
      if (entry.joinAudioUrl !== null) this.pairs.set(record.id, entry.joinAudioUrl)
      if (entry.isStream) this.streams.add(record.id)
      if (entry.streamHint) {
        this.hints.set(record.id, {
          bandwidth: entry.streamHint.bandwidth ?? undefined,
          quality: entry.streamHint.quality
        })
      }

      const { partition, referer, origin, userAgent } = entry.request
      if (partition !== null || referer !== null || userAgent !== null) {
        const session = partition !== null ? sessionFor(partition) : null
        this.contexts.set(record.id, {
          ...(session ? { session } : {}),
          ...(partition !== null ? { partition } : {}),
          ...(referer !== null ? { referer } : {}),
          ...(origin !== null ? { origin } : {}),
          ...(userAgent !== null ? { userAgent } : {})
        })
      }

      // Offered as continuable only when it genuinely is. `suspend` re-checks
      // the segment table against the file length, so a truncated or mismatched
      // one falls back to starting again rather than resuming into nonsense.
      if (state === 'paused' || state === 'failed') {
        this.suspend(record.id, entry.capabilities, entry.segments, record.savePath)
        if (this.suspended.has(record.id)) resumable += 1
      }
      // Written down as it now is, so a second crash does not resurrect the
      // "downloading" state this just corrected.
      this.lastPersisted.set(record.id, 0)
      this.persist(record.id, true)
    }

    if (saved.length > 0) {
      log.info(
        `restored ${saved.length} download(s); ${resumable} can continue from disk`
      )
    }
    this.emit()
    // Only things that were already asked to run. A paused download waits for
    // the user, which is the entire point of the paragraph above.
    this.pump()
    return { restored: saved.length, resumable }
  }

  /** Starts whatever is waiting, in priority then arrival order. */
  private pump(): void {
    // The decision - which downloads may start, and when to look again - is in
    // `selectStartable`, pure and tested. It has to weigh a per-queue limit, a
    // paused queue, a scheduled start and a global cap at once, and "why is
    // this download not starting" is otherwise the least answerable question in
    // the engine.
    //
    // `live` is consulted rather than the state alone because still-live means
    // still stopping: a download paused and resumed before its segment loops
    // unwound is queued *and* running, and starting it again would put two
    // transfers on the same ranges of the same file.
    const { start, heldUntil } = selectStartable(
      [...this.records.values()],
      new Set(this.live.keys()),
      this.queues(),
      MAX_CONCURRENT,
      Date.now()
    )

    if (heldUntil !== null) this.armScheduleTimerAt(heldUntil)
    for (const id of start) void this.begin(id)
  }

  /** Arms a single timer for the soonest scheduled download. */
  private armScheduleTimerAt(soonest: number): void {
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

    // A stream is not a file and cannot be probed for a length or ranges. It
    // takes an entirely different path — plan the playlist, then fetch and
    // join the segments — and shares only this queue, its list entry and its
    // controls, which is exactly as much sharing as it should have.
    if (this.streams.has(id) || isStreamUrl(record.url)) {
      await this.beginStream(id, record)
      return
    }

    const audioUrl = this.pairs.get(id)
    if (audioUrl !== undefined) {
      await this.beginJoined(id, record, audioUrl)
      return
    }

    // Something is already on disk for this download. Continuing it is a
    // different operation from starting one — different request, no truncation,
    // and a safety check against the server first.
    const partial = this.suspended.get(id)
    if (partial) {
      await this.beginResume(id, record, partial)
      return
    }

    log.info(`starting ${record.filename} from the beginning`)
    const download = new SegmentedDownload({
      url: record.url,
      destination: record.savePath,
      connections: this.connectionsPerFile(),
      bandwidthLimit: this.bandwidthLimit(),
      context: this.contexts.get(id),
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

    // Hoisted out of the try because the catch needs them. Pausing aborts the
    // in-flight requests, and an abort can surface as a rejection rather than a
    // clean end of stream — so the "user paused this" path has to be handled in
    // both places or a pause mid-chunk loses the partial file.
    let savePath = record.savePath
    let transfer: SegmentedDownload = download

    try {
      const capabilities = await download.probe()
      live.capabilities = capabilities

      // The server may name the file better than the URL did.
      const filename = capabilities.suggestedName ?? record.filename
      // Chosen once. A retry that re-derived it would collide with its own
      // half-finished file and quietly start again under a new name.
      savePath = await this.destinationFor(id, filename)
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
        context: this.contexts.get(id),
        onProgress: (received, segments) => this.onProgress(id, received, segments)
      })
      live.download = finalDownload
      transfer = finalDownload

      await finalDownload.run(capabilities.totalBytes, plan.connections)

      // A paused transfer resolves the same way a finished one does; only the
      // byte count distinguishes them.
      const current = this.records.get(id)
      if (!current || current.state === 'cancelled') return
      // Paused, or paused and already resumed again while these loops were
      // still unwinding. Both mean the same thing here: the transfer stopped
      // early, and what it wrote is worth keeping. Captured at this point
      // rather than in `pause()` because this is the first moment every
      // segment loop has finished and every byte it wrote is counted.
      if (current.state === 'paused' || current.state === 'queued') {
        this.suspend(id, capabilities, finalDownload.currentSegments, savePath)
        this.live.delete(id)
        // Pumping is what starts the resume, if one was asked for.
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
      this.suspended.delete(id)
      this.live.delete(id)
      this.pump()
    } catch (error) {
      this.live.delete(id)
      // Whatever stopped it, the bytes already written are worth keeping: the
      // next attempt — a retry, or the user pressing Resume — continues from
      // them instead of truncating a nearly-finished file.
      this.suspend(id, live.capabilities, transfer.currentSegments, savePath)

      const current = this.records.get(id)
      if (current?.state === 'paused' || current?.state === 'queued') {
        // Not a failure: the user stopped it, and may already have asked for it
        // back. `fail` ignores a paused record too, but returning here keeps the
        // retry counter and the error text untouched.
        this.pump()
        return
      }
      this.fail(id, error)
    }
  }

  /**
   * Continues a paused download where it stopped.
   *
   * The whole point is what it does **not** do: it does not choose a new
   * destination, it does not truncate, and it does not re-fetch a segment that
   * is already complete. `SegmentedDownload.resume` checks the server's
   * validator first — resuming into a file that changed server-side splices two
   * versions together and produces a corrupt result that looks finished, which
   * is the worst outcome this engine has.
   *
   * When continuing is refused, the download starts again **into the same
   * file**, with the reason shown. That is not a silent fallback: the byte
   * count visibly returns to zero and the note says why.
   */
  private async beginResume(
    id: string,
    record: EngineDownload,
    partial: SuspendedDownload
  ): Promise<void> {
    // Claimed before the first await. `pump` starts anything queued that is not
    // already live, and a resume that awaits before claiming its slot can be
    // started twice — two transfers writing the same ranges of the same file.
    this.live.set(id, {
      capabilities: partial.capabilities,
      lastBytes: resumePlan(partial.segments).alreadyHave,
      lastSampleAt: Date.now(),
      retryTimer: null
    })
    const held = resumePlan(partial.segments)
    log.info(
      `continuing ${record.filename} from ${held.alreadyHave} of ${held.total} bytes ` +
        `(${held.remaining.length} of ${partial.segments.length} segments left)`
    )
    this.patch(id, {
      state: 'probing',
      attempts: record.attempts + 1,
      error: null,
      connectionNote: 'Checking the file has not changed...'
    })

    // The partial file is the whole basis for continuing. If it is gone —
    // deleted by hand, or by a cleaner — there is nothing to continue into.
    if (!(await fileExists(partial.savePath))) {
      log.info(`partial file for ${record.filename} is gone; starting again`)
      this.suspended.delete(id)
      this.live.delete(id)
      this.patch(id, {
        receivedBytes: 0,
        connectionNote: 'The partly-downloaded file is gone. Starting again.'
      })
      await this.begin(id)
      return
    }

    const download = new SegmentedDownload({
      url: record.url,
      destination: partial.savePath,
      connections: this.connectionsPerFile(),
      bandwidthLimit: this.bandwidthLimit(),
      context: this.contexts.get(id),
      onProgress: (received, segments) => this.onProgress(id, received, segments)
    })
    const live = this.live.get(id)
    if (live) live.download = download

    try {
      const plan = resumePlan(partial.segments)
      this.patch(id, {
        state: 'downloading',
        savePath: partial.savePath,
        receivedBytes: plan.alreadyHave,
        connectionNote: `Continuing - ${plan.remaining.length} of ${partial.segments.length} segments left.`
      })

      const outcome = await download.resume(partial.capabilities, partial.segments)
      if (!outcome.resumed) {
        // Not safe to continue. Start again from zero, into the same file, and
        // say why — a transfer that silently restarts looks like one that never
        // progressed.
        log.info(`cannot continue ${record.filename}: ${outcome.reason}`)
        this.suspended.delete(id)
        this.live.delete(id)
        this.patch(id, { receivedBytes: 0, connectionNote: `Starting again - ${outcome.reason}` })
        await this.begin(id)
        return
      }

      const current = this.records.get(id)
      if (!current || current.state === 'cancelled') {
        this.live.delete(id)
        this.pump()
        return
      }
      if (current.state === 'paused' || current.state === 'queued') {
        this.suspend(id, partial.capabilities, download.currentSegments, partial.savePath)
        this.live.delete(id)
        this.pump()
        return
      }

      this.suspended.delete(id)
      this.patch(id, {
        state: 'completed',
        receivedBytes: partial.capabilities.totalBytes ?? download.receivedBytes,
        bytesPerSecond: 0,
        secondsRemaining: 0,
        completedAt: Date.now()
      })
      log.info(`resumed and finished ${record.filename}`)
      this.live.delete(id)
      this.pump()
    } catch (error) {
      this.live.delete(id)
      // Whatever went wrong, what is on disk is still worth keeping: the next
      // attempt continues from it rather than starting the file again.
      this.suspend(id, partial.capabilities, download.currentSegments, partial.savePath)
      this.fail(id, error)
    }
  }

  /**
   * Records what a stopped transfer left behind, when it left anything usable.
   *
   * `canContinue` is the gate: a transfer with no length, no range support, or
   * a segment table that does not add up to the file has nothing to come back
   * to, and pretending otherwise resumes into nonsense. Without it the download
   * simply starts again, which is correct and is what happened before.
   */
  private suspend(
    id: string,
    capabilities: ServerCapabilities | null,
    segments: readonly Segment[],
    savePath: string
  ): void {
    if (!capabilities || !canContinue(capabilities, segments)) {
      log.info(
        `nothing to continue for ${id}: ranges=${capabilities?.acceptsRanges ?? 'unknown'} ` +
          `total=${capabilities?.totalBytes ?? 'unknown'} segments=${segments.length}`
      )
      this.suspended.delete(id)
      return
    }
    this.suspended.set(id, {
      capabilities,
      segments: segments.map((segment) => ({ ...segment })),
      savePath
    })
  }

  /** The destination for this download, decided once and remembered. */
  private async destinationFor(id: string, filename: string): Promise<string> {
    const already = this.chosenPaths.get(id)
    if (already !== undefined) return already

    // The filename may have come from `Content-Disposition`, which is written by
    // the server. `safeFilename` already reduced it to a name; this resolves the
    // result and *verifies* it landed inside the folder, because a string
    // transform is a blocklist and a blocklist is a thing you can be wrong about.
    const directory = this.directoryFor(id)
    const confined = confinedPath(directory, filename)
    if (!confined.ok) throw new Error(confined.reason)

    // The default downloads folder always exists, which is why nothing here
    // ever had to create one. Category sorting broke that assumption: the
    // first video ever downloaded goes into a `Video` folder that does not
    // exist yet, and `fs.open(destination, 'w')` fails with ENOENT rather than
    // anything that names the real cause. Created *after* `confinedPath` has
    // verified the path, never before — this must not be able to make a
    // directory outside the download folder.
    await fs.mkdir(directory, { recursive: true })

    const chosen = await this.uniquePath(confined.path)
    this.chosenPaths.set(id, chosen)
    return chosen
  }

  /** Where this download goes: its own chosen folder, or the default. */
  private directoryFor(id: string): string {
    return this.directories.get(id) ?? this.defaultDirectory()
  }

  /**
   * Downloads a video stream and its audio, then joins them into one file.
   *
   * Sequential rather than parallel on purpose: they share a link, so running
   * both at once halves each and finishes at the same moment, while making the
   * progress bar meaningless. One after the other, with the bar spanning both,
   * is the same wall-clock time and legible throughout.
   */
  private async beginJoined(id: string, record: EngineDownload, audioUrl: string): Promise<void> {
    // Claimed **before the first await**, and this is load-bearing. `pump` starts
    // anything queued that is not already live; awaiting a unique path first
    // left a window in which a second pump saw this still queued and started it
    // again. Two runs then raced over the same part files — one deleted what
    // the other was about to read — and the download completed, silently, with
    // the video only. Found by running it, not by reading it.
    this.live.set(id, {
      capabilities: null,
      lastBytes: 0,
      lastSampleAt: Date.now(),
      retryTimer: null
    })
    this.patch(id, {
      state: 'downloading',
      attempts: record.attempts + 1,
      error: null,
      connectionNote: 'Downloading video…'
    })

    const finalPath = await this.destinationFor(id, record.filename)
    const videoPart = `${finalPath}.video.part`
    const audioPart = `${finalPath}.audio.part`
    this.patch(id, { savePath: finalPath })

    let videoBytes = 0
    const fetchPart = async (url: string, destination: string, isVideo: boolean): Promise<number> => {
      const download = new SegmentedDownload({
        url,
        destination,
        connections: this.connectionsPerFile(),
        bandwidthLimit: this.bandwidthLimit(),
        context: this.contexts.get(id),
        onProgress: (received) => this.onProgress(id, isVideo ? received : videoBytes + received, [])
      })
      const live = this.live.get(id)
      if (live) live.download = download

      const capabilities = await download.probe()
      const plan = planConnections(capabilities, this.connectionsPerFile())
      await download.run(capabilities.totalBytes, plan.connections)
      return capabilities.totalBytes ?? download.receivedBytes
    }

    try {
      videoBytes = await fetchPart(record.url, videoPart, true)
      this.patch(id, { connectionNote: 'Downloading audio…' })
      await fetchPart(audioUrl, audioPart, false)

      this.patch(id, { connectionNote: 'Joining video and audio…', bytesPerSecond: 0 })
      const joined = await this.muxer.join(videoPart, audioPart, finalPath)

      this.patch(id, {
        state: 'completed',
        bytesPerSecond: 0,
        secondsRemaining: 0,
        completedAt: Date.now(),
        connectionNote: joined
          ? 'Video and audio joined into one file.'
          : 'Saved as two files — they could not be joined, and both play on their own.'
      })
      log.info(joined ? `joined ${record.filename}` : `kept two parts for ${record.filename}`)
      this.live.delete(id)
      this.pairs.delete(id)
      this.pump()
    } catch (error) {
      this.live.delete(id)
      this.fail(id, error)
    }
  }

  /**
   * The stream path: plan the playlist, then fetch and join the segments.
   *
   * Kept separate from `begin` rather than folded into it with flags. The two
   * share no step — no probe, no ranges, no resume — and a single function
   * pretending otherwise would be a tangle of branches over two unrelated
   * transfers.
   */
  private async beginStream(id: string, record: EngineDownload): Promise<void> {
    this.patch(id, { state: 'probing', attempts: record.attempts + 1, error: null })

    const planned = await planStream(record.url, this.contexts.get(id), this.hints.get(id))
    if (!planned.ok) {
      // Not a retryable failure: an encrypted or live stream will still be
      // encrypted or live in eight seconds. Failed outright, with the reason.
      this.patch(id, {
        state: 'failed',
        error: planned.reason,
        bytesPerSecond: 0,
        secondsRemaining: null
      })
      this.pump()
      return
    }

    const { plan } = planned
    const filename = withExtension(record.filename, plan.container)
    const savePath = await this.destinationFor(id, filename)

    // A DASH stream keeps picture and sound apart, so this is two transfers and
    // a join rather than one transfer. The user sees one entry either way —
    // "your video is in two pieces, here is a tool" is an implementation detail
    // that should not reach somebody's downloads folder.
    const separateAudio = plan.audio ?? null
    const videoTarget = separateAudio ? `${savePath}.video.part` : savePath

    const stream = new StreamDownload({
      plan,
      destination: videoTarget,
      context: this.contexts.get(id),
      onProgress: (bytes, segmentsDone, segmentsTotal) => {
        this.onProgress(id, bytes, [])
        this.patch(id, {
          connectionNote: separateAudio
            ? `Video: segment ${segmentsDone} of ${segmentsTotal}`
            : `Joining segment ${segmentsDone} of ${segmentsTotal}`
        })
      }
    })

    const live: Live = {
      stream,
      capabilities: null,
      lastBytes: 0,
      lastSampleAt: Date.now(),
      retryTimer: null
    }
    this.live.set(id, live)

    this.patch(id, {
      filename,
      savePath,
      category: categorise(filename, null),
      // An estimate from the declared bitrate, and labelled as one. Segment
      // sizes are not in the playlist, and asking the server for thousands of
      // them before offering a button would take longer than the download.
      totalBytes: plan.estimatedBytes,
      connectionNote: `${plan.segments.length} segments${plan.quality ? ` · ${plan.quality}` : ''} · size is approximate`,
      state: 'downloading'
    })

    try {
      await stream.run()
      if (this.records.get(id)?.state === 'cancelled') return

      let note = 'Assembled from segments.'
      if (separateAudio) {
        const audioTarget = `${savePath}.audio.part`
        this.patch(id, { connectionNote: 'Downloading the audio track…' })

        const audioStream = new StreamDownload({
          plan: {
            segments: separateAudio.segments,
            estimatedBytes: null,
            container: separateAudio.container,
            quality: null,
            ...(separateAudio.optionalFrom === undefined
              ? {}
              : { optionalFrom: separateAudio.optionalFrom })
          },
          destination: audioTarget,
          context: this.contexts.get(id),
          onProgress: (_bytes, segmentsDone, segmentsTotal) =>
            this.patch(id, {
              connectionNote: `Audio: segment ${segmentsDone} of ${segmentsTotal}`
            })
        })
        const liveEntry = this.live.get(id)
        if (liveEntry) liveEntry.stream = audioStream
        await audioStream.run()
        if (this.records.get(id)?.state === 'cancelled') return

        this.patch(id, { connectionNote: 'Joining video and audio…', bytesPerSecond: 0 })
        const joined = await this.muxer.join(videoTarget, audioTarget, savePath)
        note = joined
          ? 'Video and audio joined into one file.'
          : 'Saved as two files — they could not be joined, and both play on their own.'
      }

      const current = this.records.get(id)
      if (!current || current.state === 'cancelled') return

      this.patch(id, {
        state: 'completed',
        bytesPerSecond: 0,
        secondsRemaining: 0,
        completedAt: Date.now(),
        connectionNote: note
      })
      log.info(`joined stream ${filename} from ${record.sourceHost}`)
      this.live.delete(id)
      this.pump()
    } catch (error) {
      this.live.delete(id)
      this.fail(id, error)
    }
  }

  /**
   * Records a failure and schedules a retry if one is worth making.
   *
   * Bounded on purpose: four attempts is enough to ride out a dropped
   * connection, and past that the fault is not transient.
   */
  private fail(id: string, error: unknown): void {
    const record = this.records.get(id)
    // Pausing and cancelling both settle the transfer by aborting its requests,
    // which surfaces here as a thrown error. Neither is a failure, and treating
    // a pause as one put the download straight into the retry loop — it
    // restarted itself a second after the user stopped it.
    if (!record || record.state === 'cancelled' || record.state === 'paused') return

    const verdict = classifyFailure(error, {
      retryAfter: (error as { retryAfter?: string | null } | null)?.retryAfter ?? null
    })

    // "The server refused this download (403)" is true and useless. On a media
    // CDN it almost always means the *address* has gone stale, not that the
    // request was wrong: these URLs are signed with a deadline, and once it
    // passes the server answers 403 to everyone — including the browser that
    // was playing the video a minute ago.
    //
    // Measured, not assumed: SLASH_MEDIA_ACCESS_PROBE fetches a freshly sniffed
    // YouTube address every way the engine can and gets 200/206 each time. What
    // fails is the same address used later, which is exactly the case here.
    const status = (error as { status?: number } | null)?.status
    const expiring = isExpiringMediaHost(record.url)
    const reason =
      status === 403 && expiring
        ? mediaUrlHasExpired(record.url)
          ? 'This address expired — these links are only valid for a few hours. Open the page ' +
            'again and start the download from there, or use "New address…" to paste a fresh one.'
          : 'The server refused this address (403). Links from this site are tied to the page ' +
            'that was open at the time — reopen the video and download it again.'
        : verdict.reason

    // A permanent failure stops here. Four attempts at a 404 is four pointless
    // requests and a minute of a progress bar that was never going to move, and
    // four attempts at a 401 is how an account gets rate-limited.
    if (!verdict.retryable) {
      this.patch(id, {
        state: 'failed',
        error: reason,
        bytesPerSecond: 0,
        secondsRemaining: null
      })
      log.warn(`download failed permanently: ${reason}`)
      this.pump()
      return
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      this.patch(id, {
        state: 'failed',
        error: verdict.reason,
        bytesPerSecond: 0,
        secondsRemaining: null
      })
      log.warn(`download failed after ${record.attempts} attempts: ${verdict.reason}`)
      this.pump()
      return
    }

    // The server's own Retry-After wins over our guess, because it knows and we
    // are guessing. Jittered otherwise, so several downloads that dropped
    // together do not retry in lockstep and arrive as a burst.
    const delay = backoffMs(record.attempts, verdict.retryAfterMs)
    this.patch(id, {
      state: 'queued',
      error: `${verdict.reason} — retrying in ${Math.round(delay / 1000)}s`,
      bytesPerSecond: 0
    })

    // Cancellation-aware: a download cancelled during a sixty-second backoff
    // stops then, and does not resurrect itself when the timer fires.
    void cancellableDelay(delay, () => {
      const current = this.records.get(id)
      return current === undefined || current.state !== 'queued'
    }).then((outcome) => {
      if (outcome === 'elapsed') this.pump()
    })
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

  private completionFired = false

  private patch(id: string, update: Partial<EngineDownload>): void {
    const record = this.records.get(id)
    if (!record) return
    this.records.set(id, { ...record, ...update })
    // A change of state is worth a transaction on its own; a change of byte
    // count is not, and is checkpointed instead.
    this.persist(id, update.state !== undefined && update.state !== record.state)
    this.emit()
  }

  /**
   * Runs the "when everything is finished" action, once.
   *
   * Guarded by `fired` because `emit` is called on every progress tick, and an
   * action that shuts the machine down must not be armed twice. Reset whenever
   * something new is queued, so a second batch gets its own countdown.
   */
  private checkCompletion(): void {
    const action = this.completionAction()
    if (action === 'nothing' || !this.onAllComplete) return
    if (this.completionFired) return

    const verdict = shouldFire([...this.records.values()])
    if (!verdict.fire) return

    this.completionFired = true
    log.info(`queue finished (${verdict.reason}) - running "${action}"`)
    this.onAllComplete(action)
  }

  private emit(): void {
    this.onChanged(this.list())
    // Every state change funnels through here, so this is the one place that
    // sees "nothing is left to run" whichever way it was reached — the last
    // download finishing, or the last unfinished one being cancelled.
    this.checkCompletion()
  }

  /**
   * Writes one download down, unless it was written a moment ago.
   *
   * `force` is for state changes — queued to downloading, downloading to
   * completed — which must survive even if the process dies in the next second.
   * Progress alone is checkpointed, because a download moving at 20 MB/s
   * produces hundreds of updates a second and none of them is worth a
   * transaction on its own.
   */
  private persist(id: string, force = false): void {
    if (!this.store || this.ephemeral.has(id)) return
    const record = this.records.get(id)
    if (!record) return

    const now = Date.now()
    if (!force && now - (this.lastPersisted.get(id) ?? 0) < PERSIST_INTERVAL_MS) return
    this.lastPersisted.set(id, now)

    const suspended = this.suspended.get(id)
    const live = this.live.get(id)
    const context = this.contexts.get(id)
    const hint = this.hints.get(id)

    this.store.save({
      record,
      // Whichever is current: a paused download's captured capabilities, or the
      // running transfer's. Without one there is nothing to resume against.
      capabilities: suspended?.capabilities ?? live?.capabilities ?? null,
      segments: suspended?.segments ?? record.segments,
      request: {
        partition: context?.partition ?? null,
        referer: context?.referer ?? null,
        origin: context?.origin ?? null,
        userAgent: context?.userAgent ?? null
      },
      joinAudioUrl: this.pairs.get(id) ?? null,
      isStream: this.streams.has(id),
      streamHint: hint ? { bandwidth: hint.bandwidth ?? null, quality: hint.quality ?? null } : null
    })
  }
}

/**
 * Whether a path is there to be continued into.
 *
 * A resume whose partial file has been deleted — by hand, by a disk cleaner —
 * would otherwise fail on the first ranged write with ENOENT, four times, and
 * report a filesystem error where the honest answer is "that file is gone, so
 * this is starting again".
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
