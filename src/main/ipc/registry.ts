import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  invokeContracts,
  eventContracts,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type EventChannel,
  type EventPayload
} from '@shared/ipc/contracts'
import type { ViewKind } from '@shared/constants'
import { type Result, err } from '@shared/result'
import { createLogger } from '../logger'
import { parseWith } from './validate'

const log = createLogger('ipc')

export interface HandlerContext {
  /** WebContents that sent the request — already verified as privileged. */
  readonly sender: WebContents
  readonly senderKind: ViewKind
}

export type Handler<C extends InvokeChannel> = (
  request: InvokeRequest<C>,
  context: HandlerContext
) => Promise<Result<InvokeResponse<C>>> | Result<InvokeResponse<C>>

/**
 * The only place in the application permitted to call `ipcMain.handle`.
 *
 * Three guarantees, in this order:
 *
 *  1. **Sender allowlist.** A request is served only if its WebContents was
 *     explicitly registered as a privileged view (chrome or overlay). Web page
 *     views are never registered, so even a compromised renderer or a leaked
 *     preload cannot reach a privileged handler — the check is on identity, not
 *     on what the caller claims to be.
 *  2. **Contract validation.** The request is parsed against its zod schema
 *     before the handler sees it, and a channel with no contract cannot be
 *     registered at all.
 *  3. **No throwing across the boundary.** Everything returns a Result.
 */
export class IpcRegistry {
  private readonly privileged = new Map<number, ViewKind>()
  private readonly registered = new Set<InvokeChannel>()

  /**
   * Marks a WebContents as allowed to invoke privileged channels. Only ever call
   * this for views we created and loaded with our own preload — never for a view
   * hosting web content.
   */
  registerPrivilegedView(contents: WebContents, kind: ViewKind): void {
    if (kind === 'page') {
      throw new Error('Refusing to grant IPC privileges to a page view')
    }
    this.privileged.set(contents.id, kind)
    contents.once('destroyed', () => this.privileged.delete(contents.id))
    log.debug(`privileged view registered: ${kind} (wc=${contents.id})`)
  }

  isPrivileged(contents: WebContents): boolean {
    return this.privileged.has(contents.id)
  }

  handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
    const contract = invokeContracts[channel]
    if (!contract) throw new Error(`No IPC contract declared for channel "${channel}"`)
    if (this.registered.has(channel)) throw new Error(`Channel "${channel}" already registered`)
    this.registered.add(channel)

    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
      const senderKind = this.privileged.get(event.sender.id)
      if (!senderKind) {
        // Loud on purpose: in normal operation this never fires, so an entry here
        // means either a bug in view registration or an actual attempt by web
        // content to reach the privileged surface.
        log.error(`BLOCKED "${channel}" from unprivileged sender wc=${event.sender.id}`, {
          url: event.senderFrame?.url
        })
        return err('FORBIDDEN', 'Not permitted from this context')
      }

      const parsed = parseWith(contract.request, raw, `request for "${channel}"`)
      if (!parsed.ok) {
        log.warn(`invalid request on "${channel}": ${parsed.error.detail ?? ''}`)
        return parsed
      }

      try {
        const result = await handler(parsed.value as InvokeRequest<C>, {
          sender: event.sender,
          senderKind
        })
        if (!result.ok) return result

        // Validate our own output too. A handler that drifts from its contract is
        // a bug we want to catch here rather than as a confusing type error in
        // the renderer, where the real cause is a process away.
        const checked = parseWith(contract.response, result.value, `response from "${channel}"`)
        if (!checked.ok) {
          log.error(`handler for "${channel}" broke its contract: ${checked.error.detail ?? ''}`)
          return err('INTERNAL', 'Internal error')
        }
        return result
      } catch (error) {
        // Full detail to the log; a generic message to the renderer.
        log.error(`handler for "${channel}" threw`, error)
        return err('INTERNAL', 'Internal error')
      }
    })
  }

  /** Push an event to every privileged view. Payload is contract-checked first. */
  broadcast<C extends EventChannel>(
    channel: C,
    payload: EventPayload<C>,
    targets: readonly WebContents[]
  ): void {
    const schema = eventContracts[channel]
    const parsed = parseWith(schema, payload, `event payload for "${channel}"`)
    if (!parsed.ok) {
      log.error(`refusing to broadcast malformed "${channel}": ${parsed.error.detail ?? ''}`)
      return
    }
    for (const contents of targets) {
      if (contents.isDestroyed()) continue
      if (!this.privileged.has(contents.id)) continue
      contents.send(channel, parsed.value)
    }
  }

  dispose(): void {
    for (const channel of this.registered) ipcMain.removeHandler(channel)
    this.registered.clear()
    this.privileged.clear()
  }
}
