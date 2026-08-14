import { app, type Session } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('session')

/**
 * A permission decision. Phase 1 answers every request with `deny`; Phase 4
 * replaces this single function with the real PermissionManager.
 *
 * Modelled as an injectable callback from the start so that swap is one
 * assignment rather than a rewrite of the handler wiring — and so the wiring
 * (which must be applied to *every* session, including Phase 2's per-workspace
 * partitions) is written and tested once.
 */
export type PermissionDecider = (request: {
  origin: string
  permission: string
  webContentsId: number | null
}) => boolean

/** Phase 1 default: deny everything and say so in the log. */
export const denyAllPermissions: PermissionDecider = ({ origin, permission }) => {
  log.info(`permission "${permission}" denied for ${origin} (Phase 4 adds real handling)`)
  return false
}

/**
 * Applies the security posture that must hold for every session the app creates.
 *
 * Called for the default session and, from Phase 2, for each `persist:ws-<id>`
 * partition. Forgetting one would give an isolated workspace weaker rules than
 * the default one, which is exactly the kind of gap that does not show up in
 * manual testing — so `SessionRegistry` is the only way to obtain a session and
 * it always hardens before handing one out.
 */
export class SessionHardening {
  private decider: PermissionDecider = denyAllPermissions

  /** Phase 4 calls this with the real PermissionManager-backed decider. */
  setPermissionDecider(decider: PermissionDecider): void {
    this.decider = decider
  }

  apply(target: Session, label: string): void {
    target.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = originOf(details?.requestingUrl ?? contents?.getURL() ?? '')
      callback(
        this.decider({
          origin,
          permission,
          webContentsId: contents?.id ?? null
        })
      )
    })

    // Synchronous counterpart, consulted by navigator.permissions.query() and by
    // getUserMedia before it prompts. It must answer from stored state without
    // prompting — returning true here would grant access with no request at all.
    target.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      return this.decider({
        origin: requestingOrigin || originOf(contents?.getURL() ?? ''),
        permission,
        webContentsId: contents?.id ?? null
      })
    })

    // Device pickers (WebUSB/WebHID/serial). Denied outright in Phase 1; these
    // are not part of the Phase 4 permission set either, so the honest answer
    // stays "no" until there is a considered design for them.
    target.setDevicePermissionHandler(() => false)

    log.debug(`hardened session: ${label}`)
  }

  /**
   * Removes the Electron and app tokens from the User-Agent.
   *
   * Electron's default UA advertises `Electron/43.4.0 adaptive-browser/0.1.0`.
   * Some sites parse that and serve a degraded or blocked experience, so the
   * browser would be broken through no fault of the page. The remaining string
   * is an accurate Chrome UA — this is not an attempt to disguise the client
   * beyond removing tokens that break feature detection.
   */
  static normaliseUserAgent(): void {
    const cleaned = app.userAgentFallback
      .replace(/\sElectron\/\S+/, '')
      .replace(new RegExp(`\\s${escapeRegExp(app.getName())}\\/\\S+`, 'i'), '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    app.userAgentFallback = cleaned
    log.info(`user agent: ${cleaned}`)
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url || 'unknown'
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
