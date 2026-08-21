import type { RequestType as AdRequestType } from '@ghostery/adblocker'

/**
 * Electron's `resourceType` to the filter syntax's request type.
 *
 * Written out rather than cast, because the two vocabularies agree on most
 * names and disagree on a few — and a silent mismatch does not fail, it just
 * applies the wrong rules. `xhr` in particular has to become
 * `xmlhttprequest`, which is the name every `$xhr` rule is written against.
 *
 * Pure and separate from `AdblockEngine`, which imports `electron`, so this
 * mapping can be tested without launching a browser.
 */
export function mapResourceType(resourceType: string): AdRequestType {
  switch (resourceType) {
    case 'mainFrame':
      return 'main_frame'
    case 'subFrame':
      return 'sub_frame'
    case 'xhr':
      return 'xmlhttprequest'
    case 'webSocket':
      return 'websocket'
    case 'cspReport':
      return 'csp_report'
    case 'stylesheet':
    case 'script':
    case 'image':
    case 'font':
    case 'object':
    case 'media':
    case 'ping':
      return resourceType as AdRequestType
    default:
      // Unknown types fall through to "other", which the lists handle.
      return 'other'
  }
}
