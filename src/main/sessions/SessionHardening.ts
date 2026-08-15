import { app, type Session, type WebContents } from 'electron'
import type { PermissionKind } from '@shared/types/permission'
import { createLogger } from '../logger'
import { isSilentlyGranted, toPermissionKinds } from '../permissions/PermissionManager'

const log = createLogger('session')

/**
 * What SessionHardening needs from the permission layer.
 *
 * An interface rather than the concrete manager so the session wiring can be
 * reasoned about — and, if ever needed, tested — without a database.
 */
export interface PermissionResolver {
  request(
    partition: string,
    origin: string,
    kinds: readonly PermissionKind[],
    tabId: string | null,
    tabTitle: string
  ): Promise<boolean>
  check(partition: string, origin: string, kind: PermissionKind, tabId: string | null): boolean
  /** Which tab a requesting WebContents belongs to, for tab-scoped grants. */
  identifyTab(webContentsId: number): { tabId: string; title: string } | null
}

/**
 * Applies the security posture that must hold for every session the app creates.
 *
 * Called for the default session and for each `persist:ws-<id>` partition.
 * Forgetting one would give an isolated workspace weaker rules than the default
 * one — exactly the kind of gap that does not show up in manual testing — so
 * `SessionRegistry` is the only way to obtain a session and it always hardens
 * before handing one out.
 */
export class SessionHardening {
  private resolver: PermissionResolver | null = null

  /**
   * Installed once the permission layer exists.
   *
   * Until then every request is denied. That ordering is deliberate: a session
   * created during startup must not be permissive for the window between being
   * created and being wired up.
   */
  setResolver(resolver: PermissionResolver): void {
    this.resolver = resolver
  }

  apply(target: Session, partition: string): void {
    target.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (isSilentlyGranted(permission)) {
        callback(true)
        return
      }

      const resolver = this.resolver
      if (!resolver) {
        log.warn(`"${permission}" denied — permission layer not ready`)
        callback(false)
        return
      }

      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
      const kinds = toPermissionKinds(permission, mediaTypes)
      if (kinds.length === 0) {
        callback(true)
        return
      }

      const origin = originOf(details.requestingUrl || contents?.getURL() || '')
      const tab = contents ? resolver.identifyTab(contents.id) : null

      void resolver
        .request(partition, origin, kinds, tab?.tabId ?? null, tab?.title ?? origin)
        .then(callback)
        .catch((error: unknown) => {
          // A failure in our own code must not become an accidental grant.
          log.error('permission request failed; denying', error)
          callback(false)
        })
    })

    // Synchronous counterpart, consulted by navigator.permissions.query() and as
    // a pre-flight before some requests. It must answer from stored state and
    // never prompt — returning true here would grant access with no request.
    target.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      const resolver = this.resolver
      if (!resolver) return false
      if (isSilentlyGranted(permission)) return true

      const kinds = toPermissionKinds(permission)
      if (kinds.length === 0) return true

      const origin = originOf(requestingOrigin || contents?.getURL() || '')
      const tab = contents ? resolver.identifyTab(contents.id) : null
      // Every kind must already be allowed; a partial grant is not a yes.
      return kinds.every((kind) => resolver.check(partition, origin, kind, tab?.tabId ?? null))
    })

    // Device pickers (WebUSB/WebHID/serial) stay denied. They are not part of the
    // Phase 4 permission set, and the honest answer is "no" until there is a
    // considered design for them rather than a prompt that cannot explain itself.
    target.setDevicePermissionHandler(() => false)

    log.debug(`hardened session: ${partition}`)
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

  /*
   * NOTE ON GOOGLE SIGN-IN, and why there is no workaround here.
   *
   * Google refuses sign-in from this browser with "This browser or app may not
   * be secure". The User-Agent is already a clean Chrome string — verified — so
   * that is not the trigger. The remaining signal is Client Hints:
   *
   *   navigator.userAgentData.brands
   *     → [{ "Not;A=Brand" }, { "Chromium", "150" }]
   *
   * A real browser also reports a *product* brand there: Chrome reports "Google
   * Chrome", Edge "Microsoft Edge", Brave "Brave". Electron reports none,
   * because that list comes from Chromium's embedder identity and Electron does
   * not expose an API to set it. An attempt to set it via a command-line switch
   * was tried and verified to do nothing.
   *
   * The only remaining route would be injecting script into every page to
   * redefine `navigator.userAgentData` and claim to be Google Chrome. That is
   * deliberately not done: the check exists to keep credentials out of embedded
   * frameworks that can read them, and defeating it by impersonating a browser
   * we are not is the wrong thing to build into a browser that tells its users
   * the truth elsewhere.
   *
   * Google allowlists browsers. Brave and Vivaldi are accepted because they went
   * through that process, not because they spoofed their way in.
   */
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

export type { WebContents }
