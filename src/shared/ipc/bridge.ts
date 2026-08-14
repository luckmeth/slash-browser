import type {
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  EventChannel,
  EventPayload
} from './contracts'
import type { Result } from '../result'

/**
 * Shape of `window.browser`, the only capability the chrome and overlay documents
 * have beyond ordinary web APIs.
 *
 * Declared in `shared/` so the preload that implements it and the renderer that
 * consumes it are checked against one definition — they live in separate
 * tsconfig projects and would otherwise be free to drift apart.
 */
export interface BrowserBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    request: InvokeRequest<C>
  ): Promise<Result<InvokeResponse<C>>>

  /** Subscribes to a main→renderer event. Returns an unsubscribe function. */
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void
}
