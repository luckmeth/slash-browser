import type { DownloadPriority, EngineDownload } from '@shared/types/downloadEngine'

/** The queue every download belongs to unless it was moved. */
export const DEFAULT_QUEUE_ID = 'main'

export interface QueueDefinition {
  readonly id: string
  readonly name: string
  /** Downloads this queue may run at once. */
  readonly maxConcurrent: number
  /** A paused queue starts nothing; what is already running is left alone. */
  readonly paused: boolean
}

export const DEFAULT_QUEUES: QueueDefinition[] = [
  { id: DEFAULT_QUEUE_ID, name: 'Main', maxConcurrent: 3, paused: false }
]

const PRIORITY_ORDER: Record<DownloadPriority, number> = { high: 0, normal: 1, low: 2 }

/**
 * Which downloads may start right now, and when to look again.
 *
 * Queues are the feature people mean by "let this batch run overnight while I
 * keep using the other one", and the whole value is that they are
 * **independent**: pausing one must not hold up another, and a queue limited to
 * one connection must not be able to starve the rest.
 *
 * Two ceilings therefore apply at once. Each queue has its own `maxConcurrent`,
 * which is the point of the feature; and a global cap sits above all of them,
 * because five queues of three would otherwise open fifteen simultaneous
 * transfers and every one of them would be slower than running them in turn.
 *
 * Pure and clock-injected, like `ResourcePolicyEngine`, because "why is this
 * download not starting" is otherwise the least debuggable question in the
 * engine. A download can be held back by its own schedule, its queue's pause,
 * its queue's limit, or the global cap, and only a tested function can be
 * trusted to say which.
 */
export function selectStartable(
  records: readonly EngineDownload[],
  liveIds: ReadonlySet<string>,
  queues: readonly QueueDefinition[],
  globalCap: number,
  now: number
): { start: string[]; heldUntil: number | null } {
  const byId = new Map(queues.map((queue) => [queue.id, queue]))
  const fallback = queues[0] ?? DEFAULT_QUEUES[0]!
  const queueOf = (record: EngineDownload): QueueDefinition =>
    byId.get(record.queue) ?? fallback

  // Live downloads count against their queue whether or not that queue is
  // paused: pausing stops new starts, it does not evict what is running.
  const liveInQueue = new Map<string, number>()
  let liveTotal = 0
  for (const record of records) {
    if (!liveIds.has(record.id)) continue
    liveTotal += 1
    const id = queueOf(record).id
    liveInQueue.set(id, (liveInQueue.get(id) ?? 0) + 1)
  }

  const candidates = records
    .filter((record) => record.state === 'queued' && !liveIds.has(record.id))
    .sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.startedAt - b.startedAt
    )

  // The soonest scheduled start, so one timer can be armed instead of polling.
  let heldUntil: number | null = null
  const start: string[] = []

  for (const record of candidates) {
    if (record.startAfter !== null && record.startAfter > now) {
      heldUntil = heldUntil === null ? record.startAfter : Math.min(heldUntil, record.startAfter)
      continue
    }

    if (liveTotal + start.length >= globalCap) continue

    const queue = queueOf(record)
    if (queue.paused) continue

    const running =
      (liveInQueue.get(queue.id) ?? 0) +
      start.filter((id) => queueOf(records.find((r) => r.id === id)!).id === queue.id).length
    if (running >= queue.maxConcurrent) continue

    start.push(record.id)
  }

  return { start, heldUntil }
}

/**
 * Why one download is not running, in the words the list should use.
 *
 * The reasons are ordered by how specific they are, so the row says the thing
 * the user can act on rather than the first thing that happens to be true.
 */
export function whyHeld(
  record: EngineDownload,
  queues: readonly QueueDefinition[],
  now: number
): string | null {
  if (record.state !== 'queued') return null

  if (record.startAfter !== null && record.startAfter > now) {
    return `Scheduled for ${new Date(record.startAfter).toLocaleString()}.`
  }

  const queue = queues.find((entry) => entry.id === record.queue)
  if (queue?.paused) return `The ${queue.name} queue is paused.`

  return 'Waiting for a free slot.'
}
