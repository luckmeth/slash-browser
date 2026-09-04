import { join } from 'node:path'
import { WebContentsView, type Session } from 'electron'

/**
 * Builds the `WebContentsView` that hosts a web page.
 *
 * Every security-relevant preference for web content is set here and nowhere
 * else. Creating a page view by any other route would bypass these, so this is
 * the single audit point for the question "what can a web page do in this
 * browser?".
 */
export function createPageView(pageSession: Session): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      session: pageSession,

      // The zero-privilege preload. It exposes nothing; see preload/content.ts.
      preload: join(__dirname, '../preload/content.js'),

      // Non-negotiable for anything that renders untrusted content.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,

      // Chromium's own process-per-site isolation. This is what makes a
      // compromised renderer unable to read another origin's memory — and also
      // why Phase 3's per-tab metrics have to be reported as per-process.
      // (Enabled by default; set explicitly so a future edit must be deliberate.)
      webviewTag: false,

      // Background throttling is what Phase 3's FROZEN state leans on. Left on
      // by default here so idle background tabs already cost less before the
      // performance engine exists.
      backgroundThrottling: true,

      // Autoplay: Chromium's default already requires a user gesture for audible
      // media. Phase 4 exposes this per-tab; note that it is fixed at view
      // creation, which is why changing it later requires a reload.
      autoplayPolicy: 'user-gesture-required',

      // Spellchecking in text areas, with suggestions offered in the context
      // menu. Users expect red squiggles in a browser; their absence is a small
      // but constant reminder that this is not one.
      spellcheck: true,

      // Chromium's built-in PDF viewer. Without this a PDF link downloads
      // instead of opening, which every other browser treats as a bug.
      //
      // `plugins` here does **not** mean NPAPI or Flash — those are long gone
      // from Chromium and cannot be re-enabled. In Electron this flag gates
      // exactly one thing: the bundled PDF renderer. It runs in its own
      // sandboxed process like any other page, so the security preferences
      // above still hold for it.
      plugins: true
    }
  })
}
