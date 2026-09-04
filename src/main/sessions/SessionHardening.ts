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
   * Declares who we are in the User-Agent: Chromium's version, plus `Slash/x.y`.
   *
   * Two changes to Electron's default, in opposite directions:
   *
   *  - `Electron/43.4.0` is dropped. It names the toolkit, not the browser, and
   *    sites that sniff for it serve a degraded page — a compatibility problem
   *    with no upside, since the engine really is Chromium 150.
   *  - `Slash/0.1.0` is *kept*. This browser is not Google Chrome and should not
   *    claim to be. Vivaldi ships its token for the same reason.
   *
   * An earlier version stripped both, producing a string byte-identical to
   * Chrome's. That was impersonation, it was not needed for compatibility, and
   * it did not help with the thing it was suspected of helping with — see the
   * measurement below.
   */
  static normaliseUserAgent(): void {
    const base = app.userAgentFallback
      .replace(/\sElectron\/\S+/, '')
      .replace(new RegExp(`\\s${escapeRegExp(app.getName())}\\/\\S+`, 'i'), '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    const declared = `${base} Slash/${app.getVersion()}`
    app.userAgentFallback = declared
    log.info(`user agent: ${declared}`)
  }

  /*
   * NOTE ON GOOGLE SIGN-IN — measured, not assumed.
   *
   * Google refuses sign-in with "This browser or app may not be secure". The
   * signal is User-Agent Client Hints, and the measured value here is not merely
   * missing a product brand — it is entirely empty:
   *
   *   navigator.userAgentData.brands            → []
   *   navigator.userAgentData.platform          → ""
   *   getHighEntropyValues().fullVersionList    → []
   *
   * Chrome reports `[{"Chromium","150"},{"Google Chrome","150"},{"Not;A=Brand"}]`
   * and `platform: "Windows"`. An empty list is not a browser Google failed to
   * recognise; it is the absence of the field the check reads.
   *
   * Verified with `SLASH_GOOGLE_DIAGNOSTIC` (see docs/testing/google-signin.md):
   *
   *  - The list is empty whether or not this class touches the UA string, so the
   *    UA is not the cause and editing it is not the fix.
   *  - `navigator.webdriver` is false; no automation marker is involved.
   *  - Electron exposes `setUserAgent(string)` and nothing else — its typings
   *    contain no reference to user-agent metadata, brands, or client hints.
   *    There is no API to populate this, and a command-line switch was tried and
   *    verified to do nothing.
   *
   * The only remaining route would be injecting script into every page to
   * redefine `navigator.userAgentData` and claim to be Google Chrome. That is
   * deliberately not done: the check exists to keep credentials out of embedded
   * frameworks that can read them, and defeating it by impersonating a browser
   * we are not is the wrong thing to build into a browser that tells its users
   * the truth elsewhere.
   *
   * The honest answer is the hand-off — see shared/externalHandoff.ts.
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
