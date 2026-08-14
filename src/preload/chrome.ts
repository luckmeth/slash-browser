import { contextBridge, ipcRenderer } from 'electron'
// Values come from the zod-free channels module; the schema-derived types are
// type-only imports and are erased, so no schema code reaches this bundle.
import { isInvokeChannel, isEventChannel, type InvokeChannel, type EventChannel } from '@shared/ipc/channels'
import type { InvokeRequest, InvokeResponse, EventPayload } from '@shared/ipc/contracts'
import type { Result } from '@shared/result'
import type { BrowserBridge } from '@shared/ipc/bridge'

/**
 * The privileged bridge, exposed only to our own chrome and overlay documents.
 *
 * This runs with `sandbox: true`, so there is no Node here — `ipcRenderer` is the
 * entire capability surface, and it is never handed to the page. Channel names
 * are checked against the contract list before use, so even if renderer code is
 * compromised it cannot address an arbitrary channel string; the main process
 * then independently re-checks both the sender and the payload.
 */
const api: BrowserBridge = {
  invoke<C extends InvokeChannel>(
    channel: C,
    request: InvokeRequest<C>
  ): Promise<Result<InvokeResponse<C>>> {
    if (!isInvokeChannel(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'FORBIDDEN', message: `Unknown channel "${String(channel)}"` }
      })
    }
    return ipcRenderer.invoke(channel, request)
  },

  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void {
    if (!isEventChannel(channel)) return () => {}
    // Drop the IpcRendererEvent: it carries a `sender` handle that must not reach
    // renderer code.
    const wrapped = (_event: unknown, payload: EventPayload<C>): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('browser', api)
