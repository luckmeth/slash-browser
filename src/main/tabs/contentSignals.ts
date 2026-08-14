import { ipcMain, type IpcMainEvent } from 'electron'
import { z } from 'zod'
import { createLogger } from '../logger'
import type { Tab } from './Tab'

const log = createLogger('content')

/**
 * The one channel web content may send on.
 *
 * Kept out of `IpcRegistry` on purpose. That registry is the privileged surface:
 * it allowlists senders and refuses anything that is not our own chrome or
 * overlay view. This is the opposite case — the sender IS untrusted web content,
 * by design — so it gets its own listener with its own rules:
 *
 *   - one-way `send`, never `invoke`; there is no reply channel to abuse
 *   - the payload is schema-validated and reduced to a single boolean
 *   - the message can only ever affect the tab it came from, resolved by
 *     WebContents id rather than by anything the payload claims
 *
 * Worst case for a fully compromised renderer: it keeps its own tab awake.
 */
const CONTENT_STATE_CHANNEL = 'content:state'

const ContentStateSchema = z.object({
  hasUnsavedInput: z.boolean()
})

export type ResolveTabBySender = (webContentsId: number) => Tab | null

export function installContentSignalListener(resolveTab: ResolveTabBySender): () => void {
  const listener = (event: IpcMainEvent, raw: unknown): void => {
    const parsed = ContentStateSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn(`malformed content:state from wc=${event.sender.id}`)
      return
    }

    // Identity comes from the sender, never from the payload. A page cannot
    // name another tab.
    const tab = resolveTab(event.sender.id)
    if (!tab) return

    tab.setHasUnsavedInput(parsed.data.hasUnsavedInput)
  }

  ipcMain.on(CONTENT_STATE_CHANNEL, listener)
  return () => ipcMain.removeListener(CONTENT_STATE_CHANNEL, listener)
}
