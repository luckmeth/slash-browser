import type { BrowserBridge } from '@shared/ipc/bridge'

declare global {
  interface Window {
    /** Injected by `preload/chrome.ts`. Absent in any document without that preload. */
    readonly browser: BrowserBridge
  }
}

export {}
