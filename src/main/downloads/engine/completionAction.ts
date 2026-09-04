import type { EngineDownload } from '@shared/types/downloadEngine'

/** What to do once the queue has nothing left to run. */
export type CompletionAction = 'nothing' | 'notify' | 'quit' | 'sleep' | 'shutdown'

/**
 * How long the user gets to call it off.
 *
 * Long enough to notice a notification and reach the mouse, short enough that
 * somebody who walked away expecting the machine to sleep is not still waiting.
 * Anything destructive must be cancellable, and shutting a machine down with
 * unsaved work in other applications qualifies.
 */
export const COMPLETION_GRACE_MS = 30_000

/** Actions that end the session and therefore need a countdown first. */
export function isDisruptive(action: CompletionAction): boolean {
  return action === 'quit' || action === 'sleep' || action === 'shutdown'
}

/**
 * Whether the queue has reached the state that fires the action.
 *
 * "Everything finished" is not "nothing is running". A queue holding a failed
 * download, or one paused halfway, has not finished - and shutting the machine
 * down on it would throw away a transfer the user still wants and had every
 * reason to expect to find in the morning. So this requires that **something
 * actually completed** and that nothing is left in a state a person would want
 * to come back to.
 *
 * Pure, because the consequence is switching off a computer. That is not a
 * decision to leave to an inline condition nobody can test.
 */
export function shouldFire(downloads: readonly EngineDownload[]): {
  fire: boolean
  reason: string
} {
  if (downloads.length === 0) {
    return { fire: false, reason: 'There are no downloads.' }
  }

  // `queued` covers both waiting for a slot and waiting for a scheduled start;
  // `probing` is a transfer that has begun asking the server questions. There
  // is no separate 'scheduled' or 'retrying' state in this engine.
  const live = downloads.filter(
    (download) =>
      download.state === 'downloading' ||
      download.state === 'queued' ||
      download.state === 'probing'
  )
  if (live.length > 0) {
    return { fire: false, reason: `${live.length} still running.` }
  }

  // A paused transfer is one somebody intends to continue. Ending the session
  // under it is the opposite of what they asked for.
  const paused = downloads.filter((download) => download.state === 'paused')
  if (paused.length > 0) {
    return { fire: false, reason: `${paused.length} paused — those are meant to be continued.` }
  }

  const failed = downloads.filter((download) => download.state === 'failed')
  if (failed.length > 0) {
    return {
      fire: false,
      reason: `${failed.length} failed, so the queue did not finish. Nothing will happen automatically.`
    }
  }

  const completed = downloads.filter((download) => download.state === 'completed')
  if (completed.length === 0) {
    return { fire: false, reason: 'Nothing completed.' }
  }

  return { fire: true, reason: `${completed.length} finished with nothing left to run.` }
}
