import { randomUUID } from 'node:crypto'
import {
  ALLOW_UNTIL_DEFAULT_MS,
  PERSISTED_POLICIES,
  type PermissionKind,
  type PermissionPolicy,
  type PermissionRequest
} from '@shared/types/permission'
import type { PermissionRepository } from '../db/repositories/PermissionRepository'
import { createLogger } from '../logger'

const log = createLogger('permissions')

/** How often lapsed grants are swept. */
const SWEEP_INTERVAL_MS = 30_000

interface PendingRequest {
  request: PermissionRequest
  partition: string
  resolve: (granted: boolean) => void
}

export interface PermissionManagerHooks {
  /** Show the prompt. Returning false means no UI could be shown. */
  showPrompt: (request: PermissionRequest) => boolean
  dismissPrompt: (requestId: string) => void
  onGrantsChanged: () => void
}

/**
 * Decides every permission question the browser is asked.
 *
 * Two distinct entry points with different rules:
 *
 *  - `request` is asynchronous and may prompt. It is what a page triggers by
 *    calling `getUserMedia`, `Notification.requestPermission` and so on.
 *  - `check` is **synchronous** and must never prompt. Chromium calls it for
 *    `navigator.permissions.query()` and as a pre-flight before some requests.
 *    Answering optimistically here would grant access with no request at all, so
 *    it only ever reports what is already stored.
 */
export class PermissionManager {
  private readonly pending = new Map<string, PendingRequest>()
  /** Memory-only grants: `partition|origin|kind` → tabId or 'session'. */
  private readonly ephemeral = new Map<string, string>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly repository: PermissionRepository,
    private hooks: PermissionManagerHooks
  ) {}

  setHooks(hooks: PermissionManagerHooks): void {
    this.hooks = hooks
  }

  start(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    // Clear anything that lapsed while the browser was closed.
    this.sweep()
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    // Deny everything still waiting; a pending promise that never settles would
    // hang the page's permission callback forever.
    for (const [id] of this.pending) this.settle(id, false)
  }

  private sweep(): void {
    const expired = this.repository.sweepExpired(Date.now())
    if (expired.length > 0) {
      log.info(`${expired.length} permission grant(s) expired`)
      this.hooks.onGrantsChanged()
    }
  }

  /**
   * Synchronous check. Returns a decision only when one is already recorded.
   *
   * Never prompts and never grants by default — an unknown permission is a no.
   */
  check(partition: string, origin: string, kind: PermissionKind, tabId: string | null): boolean {
    const ephemeralKey = this.key(partition, origin, kind)
    const scope = this.ephemeral.get(ephemeralKey)
    if (scope === 'session') return true
    if (scope !== undefined && tabId !== null && scope === tabId) return true

    const stored = this.repository.find(partition, origin, kind)
    if (!stored) return false
    return stored.policy === 'always-allow' || stored.policy === 'allow-until'
  }

  /**
   * Asynchronous request. Resolves once the user answers, or immediately when a
   * stored decision already covers it.
   *
   * @param kinds Several when a page asks for camera and microphone together —
   *              Chromium gives one callback for both, so they are answered as
   *              one decision.
   */
  async request(
    partition: string,
    origin: string,
    kinds: readonly PermissionKind[],
    tabId: string | null,
    tabTitle: string
  ): Promise<boolean> {
    if (kinds.length === 0) return false

    for (const kind of kinds) {
      this.repository.logEvent(partition, origin, kind, 'requested', null)
    }

    // A stored "never" wins without any prompt — that is what "never" means.
    for (const kind of kinds) {
      const stored = this.repository.find(partition, origin, kind)
      if (stored?.policy === 'always-block') {
        log.info(`"${kind}" auto-denied for ${origin} (always-block)`)
        return false
      }
    }

    // Every kind already allowed → no need to ask again.
    const allSatisfied = kinds.every((kind) => this.check(partition, origin, kind, tabId))
    if (allSatisfied) return true

    const request: PermissionRequest = {
      requestId: randomUUID(),
      origin,
      kinds: [...kinds],
      tabId,
      tabTitle
    }

    return new Promise<boolean>((resolve) => {
      this.pending.set(request.requestId, { request, partition, resolve })
      if (!this.hooks.showPrompt(request)) {
        // No window could display the prompt. Denying is the only safe answer —
        // silently granting because the UI failed would be the worst outcome.
        log.warn(`no UI available to prompt for ${origin}; denying`)
        this.settle(request.requestId, false)
      }
    })
  }

  /** The user answered. */
  respond(requestId: string, policy: PermissionPolicy): void {
    const entry = this.pending.get(requestId)
    if (!entry) return

    const granted = policy !== 'block' && policy !== 'always-block'
    const { partition, request } = entry

    for (const kind of request.kinds) {
      this.record(partition, request.origin, kind, policy, request.tabId)
      this.repository.logEvent(
        partition,
        request.origin,
        kind,
        granted ? 'granted' : 'denied',
        policy
      )
    }

    log.info(`${granted ? 'granted' : 'denied'} ${request.kinds.join('+')} for ${request.origin} (${policy})`)
    this.settle(requestId, granted)
    this.hooks.onGrantsChanged()
  }

  private record(
    partition: string,
    origin: string,
    kind: PermissionKind,
    policy: PermissionPolicy,
    tabId: string | null
  ): void {
    const ephemeralKey = this.key(partition, origin, kind)

    if (policy === 'allow-for-session') {
      this.ephemeral.set(ephemeralKey, 'session')
      return
    }
    if (policy === 'allow-for-tab' && tabId) {
      this.ephemeral.set(ephemeralKey, tabId)
      return
    }
    // allow-once and block leave no trace at all; the next request asks again.
    if (!PERSISTED_POLICIES.includes(policy)) return

    this.repository.upsert({
      partition,
      origin,
      kind,
      policy,
      expiresAt: policy === 'allow-until' ? Date.now() + ALLOW_UNTIL_DEFAULT_MS : null,
      tabId: null
    })
  }

  private settle(requestId: string, granted: boolean): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    this.hooks.dismissPrompt(requestId)
    entry.resolve(granted)
  }

  /**
   * Denies anything this tab was still waiting on.
   *
   * Called when a tab navigates or closes: the page that asked is gone, so a
   * prompt still on screen would be attributing a request to the wrong page.
   */
  cancelForTab(tabId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.request.tabId === tabId) this.settle(id, false)
    }
    // allow-for-tab grants die with the tab.
    for (const [key, scope] of this.ephemeral) {
      if (scope === tabId) this.ephemeral.delete(key)
    }
  }

  listGrants(): ReturnType<PermissionRepository['list']> {
    return this.repository.list()
  }

  listEvents(limit: number): ReturnType<PermissionRepository['listEvents']> {
    return this.repository.listEvents(limit)
  }

  revoke(partition: string, origin: string, kind: PermissionKind): void {
    this.repository.deleteFor(partition, origin, kind)
    this.ephemeral.delete(this.key(partition, origin, kind))
    this.repository.logEvent(partition, origin, kind, 'revoked', null)
    this.hooks.onGrantsChanged()
  }

  pendingRequest(requestId: string): PermissionRequest | null {
    return this.pending.get(requestId)?.request ?? null
  }

  private key(partition: string, origin: string, kind: PermissionKind): string {
    return `${partition}|${origin}|${kind}`
  }
}

/**
 * Maps Electron's permission strings onto ours.
 *
 * `media` splits into camera and microphone using `mediaTypes`; when Chromium
 * does not say which, both are assumed, because assuming less would under-state
 * what the page is asking for.
 */
export function toPermissionKinds(
  electronPermission: string,
  mediaTypes?: readonly string[]
): PermissionKind[] {
  switch (electronPermission) {
    case 'media': {
      if (!mediaTypes || mediaTypes.length === 0) return ['camera', 'microphone']
      const kinds: PermissionKind[] = []
      if (mediaTypes.includes('video')) kinds.push('camera')
      if (mediaTypes.includes('audio')) kinds.push('microphone')
      return kinds.length > 0 ? kinds : ['camera', 'microphone']
    }
    case 'geolocation':
      return ['geolocation']
    case 'notifications':
      return ['notifications']
    case 'clipboard-read':
    case 'deprecated-sync-clipboard-read':
      return ['clipboard-read']
    case 'display-capture':
      return ['display-capture']
    case 'midi':
    case 'midiSysex':
      return ['midi']
    case 'fullscreen':
      return ['fullscreen']
    case 'pointerLock':
    case 'keyboardLock':
      return ['pointer-lock']
    case 'idle-detection':
      return ['idle-detection']
    case 'window-management':
      return ['window-management']
    case 'storage-access':
    case 'top-level-storage-access':
      return ['storage-access']
    case 'fileSystem':
      return ['file-system']
    case 'openExternal':
      return ['open-external']
    case 'speaker-selection':
      return ['speaker-selection']

    // Granted silently: writing to the clipboard in response to a user gesture,
    // and media-key playback, are not capabilities worth interrupting for.
    case 'clipboard-sanitized-write':
    case 'mediaKeySystem':
      return []

    default:
      return ['unknown']
  }
}

/** Permissions we answer without ever prompting. */
export function isSilentlyGranted(electronPermission: string): boolean {
  return (
    electronPermission === 'clipboard-sanitized-write' ||
    electronPermission === 'mediaKeySystem' ||
    // Fullscreen is granted without asking, as every mainstream browser does.
    //
    // It only ever arrives after the user has clicked something asking for it,
    // it reveals nothing, and Escape leaves at any time — which is exactly what
    // this permission's own consequence text says. Prompting turned "click the
    // fullscreen button on a video" into a dialog, and a request the user never
    // answered simply never entered fullscreen, so the feature read as broken.
    //
    // `pointer-lock` is deliberately NOT added: it is equally reversible but it
    // hides the cursor, which is a different kind of surprise, and nobody has
    // asked for it.
    electronPermission === 'fullscreen'
  )
}
