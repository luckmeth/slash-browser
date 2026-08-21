import type { ExtensionGap } from '@shared/types/extensions'

/**
 * What an extension asked for that Electron will not give it.
 *
 * Pure, and separate from the manager for the usual reason: the manager imports
 * `electron` and cannot be loaded by the test runner. This is the part worth
 * testing, because being wrong here means the interface tells a user their
 * extension works when it does not.
 *
 * The list is deliberately confined to gaps that are **certain** and that
 * matter. Electron's extension support is a subset of Chrome's, and guessing at
 * the edges would produce warnings nobody can act on.
 */
export function gapsFor(manifest: unknown): ExtensionGap[] {
  const gaps: ExtensionGap[] = []
  if (typeof manifest !== 'object' || manifest === null) return gaps

  const record = manifest as Record<string, unknown>
  const permissions = [
    ...toStringArray(record['permissions']),
    ...toStringArray(record['optional_permissions'])
  ]
  const manifestVersion = typeof record['manifest_version'] === 'number' ? record['manifest_version'] : 2

  // The one that breaks download managers. Electron has no native messaging
  // host bridge at all, so an extension whose whole job is talking to a desktop
  // application cannot do it.
  if (permissions.includes('nativeMessaging')) {
    gaps.push({
      capability: 'nativeMessaging',
      detail:
        'This extension talks to a desktop program installed alongside it. Electron has no way to make that connection, so that part cannot work. Download managers rely on it.'
    })
  }

  // Blocking webRequest was removed from Chrome for MV3 and was never
  // implemented in Electron for either version. This is why a content blocker
  // extension cannot block anything here.
  if (permissions.includes('webRequestBlocking')) {
    gaps.push({
      capability: 'webRequestBlocking',
      detail:
        'This extension expects to cancel network requests. Electron does not support that, so it will not block anything. Slash Shield does this job instead.'
    })
  }

  if (permissions.includes('declarativeNetRequest') || permissions.includes('declarativeNetRequestWithHostAccess')) {
    gaps.push({
      capability: 'declarativeNetRequest',
      detail:
        'Request-blocking rules are only partly supported, so filtering will be incomplete. Slash Shield does this job instead.'
    })
  }

  if (permissions.includes('downloads')) {
    gaps.push({
      capability: 'downloads',
      detail:
        'Electron does not expose the downloads API to extensions. Slash has its own download manager with resumable, segmented downloads.'
    })
  }

  // MV3 moved background pages to service workers, which Electron supports
  // incompletely. Stated as a caution rather than a failure because plenty of
  // MV3 extensions do work.
  if (manifestVersion >= 3 && hasServiceWorker(record)) {
    gaps.push({
      capability: 'service worker background',
      detail:
        'Manifest V3 background service workers are only partly supported. The extension may load and still behave unpredictably.'
    })
  }

  return gaps
}

function hasServiceWorker(record: Record<string, unknown>): boolean {
  const background = record['background']
  return (
    typeof background === 'object' &&
    background !== null &&
    'service_worker' in (background as Record<string, unknown>)
  )
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
