import { app } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Will Google let somebody sign in *inside* Slash?
 *
 * The browser has been telling users it will not, and that claim deserves
 * testing rather than repeating. Two mechanisms get conflated here and they are
 * not the same thing:
 *
 *  - **FedCM** is what breaks `claude.ai/login`. It is a browser API Electron
 *    does not implement, and nothing about a user agent changes that.
 *  - **`disallowed_useragent`** is Google's anti-phishing policy for embedded
 *    webviews, and it is decided almost entirely by the user agent string.
 *    Electron's default advertises `Electron/43.x` and the application name,
 *    which is exactly the signature that policy looks for.
 *
 * The OAuth redirect flow needs neither FedCM nor an embedded webview — it is
 * an ordinary top-level navigation. So the question is only whether Google
 * refuses the user agent, and that is measurable: load the real authorize URL
 * twice, once as shipped and once presenting as plain Chrome, and read what
 * comes back.
 */
const AUTHORIZE =
  process.env['SLASH_GOOGLE_URL'] ??
  'https://edsuuwzihojdsmgzhzyw.supabase.co/auth/v1/authorize?provider=google&redirect_to=' +
    encodeURIComponent('http://127.0.0.1:54321/callback')

/** Electron's default UA with the two giveaway tokens removed. */
export function browserLikeUserAgent(original: string): string {
  return original
    .replace(/\sElectron\/[\d.]+/g, '')
    .replace(/\sSlash\/[\d.]+/g, '')
    .trim()
}

export async function runGoogleUaProbe(window: BrowserWindowController): Promise<void> {
  const tabs = window.tabs
  let activeId = tabs.snapshot().activeTabId
  for (let i = 0; i < 40 && !activeId; i++) {
    await delay(250)
    activeId = tabs.snapshot().activeTabId
  }
  if (!activeId) {
    log.error('google-ua probe: FAIL — no tab')
    app.quit()
    return
  }

  // The new tab page is an internal page and therefore has no view at all, so
  // there is nothing to read a user agent from until something real is loaded.
  tabs.navigate(activeId, 'https://example.com')
  let contents = tabs.activeTab?.contents ?? null
  for (let i = 0; i < 40 && !contents; i++) {
    await delay(250)
    contents = tabs.activeTab?.contents ?? null
  }
  if (!contents) {
    log.error('google-ua probe: FAIL — tab never got a view')
    app.quit()
    return
  }
  await delay(1500)

  const shipped = contents.getUserAgent()
  const cleaned = browserLikeUserAgent(shipped)
  log.info(`google-ua probe: shipped UA = ${shipped}`)
  log.info(`google-ua probe: cleaned UA = ${cleaned}`)
  log.info(`google-ua probe: removed Electron token = ${shipped !== cleaned}`)

  const look = async (label: string): Promise<void> => {
    tabs.navigate(activeId as string, AUTHORIZE)
    await delay(9000)
    const live = tabs.activeTab?.contents
    if (!live) {
      log.error(`google-ua probe [${label}]: no contents`)
      return
    }
    const verdict = await live
      .executeJavaScript(
        `(() => {
          const text = (document.body && document.body.innerText || '').slice(0, 4000);
          const lower = text.toLowerCase();
          return {
            url: location.href.slice(0, 120),
            blocked: lower.includes('disallowed_useragent') ||
                     lower.includes('this browser or app may not be secure') ||
                     lower.includes("couldn't sign you in"),
            signinForm: !!document.querySelector('input[type=email], input[name=identifier]'),
            chooser: lower.includes('choose an account'),
            snippet: text.replace(/\\s+/g, ' ').slice(0, 180)
          };
        })()`,
        true
      )
      .catch((error: unknown) => ({ error: String(error) }))
    log.info(`google-ua probe [${label}]: ${JSON.stringify(verdict)}`)
  }

  await look('shipped UA')

  contents.setUserAgent(cleaned)
  await look('cleaned UA')

  log.info('google-ua probe: done')
  app.quit()
}
