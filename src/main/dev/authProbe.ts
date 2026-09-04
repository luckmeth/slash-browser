import { app } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TARGET = process.env['SLASH_AUTH_URL'] ?? 'https://claude.ai/login'

/**
 * Why does one site refuse to sign in when the others are fine?
 *
 * "Google works everywhere, Claude does not" is a useful report precisely
 * because it rules most things out: the user agent, client hints and the
 * permission handlers are shared by every session, so anything global would
 * break Google too. That leaves something specific to the page — a storage
 * partition it cannot write, a worker it cannot register, a request being
 * refused by Shield, or a check of its own.
 *
 * So this collects what the page itself reports rather than reasoning from the
 * browser's configuration: console errors, failed requests, and whether the
 * storage primitives a login flow needs actually work in that origin.
 */
export async function runAuthProbe(window: BrowserWindowController): Promise<void> {
  for (let waited = 0; waited < 15000 && !window.tabs.snapshot().activeTabId; waited += 200) {
    await delay(200)
  }
  const activeId = window.tabs.snapshot().activeTabId
  if (!activeId) {
    log.error('auth probe: FAIL — no tab')
    app.quit()
    return
  }

  const contents = window.tabs.activeTab?.contents ?? null
  const messages: string[] = []
  const failures: string[] = []

  if (contents) {
    contents.on('console-message', (_event, level, message, line, source) => {
      // Level 2 is a console error, 3 is a browser-side error.
      if (level >= 2) messages.push(`[${level}] ${message.slice(0, 180)} (${source}:${line})`)
    })
    contents.session.webRequest.onErrorOccurred((details) => {
      // Everything, not just the site's own origins. A login that depends on a
      // third-party captcha fails on *its* requests, not on the site's.
      failures.push(`${details.error} ${details.url.slice(0, 110)}`)
    })
  }

  log.info(`auth probe: loading ${TARGET}`)
  window.tabs.navigate(activeId, TARGET)
  await delay(14_000)

  const page = window.tabs.activeTab?.contents ?? null
  if (!page || page.isDestroyed()) {
    log.error('auth probe: FAIL — the tab has no contents after loading')
    if (process.env['SLASH_PROBE_EXIT']) app.quit()
    return
  }

  log.info(`auth probe: final url = ${page.getURL().slice(0, 140)}`)

  // What a login flow actually needs, asked inside the origin itself.
  const capabilities = (await page
    .executeJavaScript(
      `(() => {
         const probe = {};
         try { localStorage.setItem('__slash', '1'); probe.localStorage = localStorage.getItem('__slash') === '1'; localStorage.removeItem('__slash'); }
         catch (e) { probe.localStorage = 'threw: ' + e.name }
         try { sessionStorage.setItem('__slash', '1'); probe.sessionStorage = true; sessionStorage.removeItem('__slash'); }
         catch (e) { probe.sessionStorage = 'threw: ' + e.name }
         try { document.cookie = '__slash=1; SameSite=Lax'; probe.cookies = document.cookie.includes('__slash'); }
         catch (e) { probe.cookies = 'threw: ' + e.name }
         probe.indexedDB = typeof indexedDB !== 'undefined';
         probe.serviceWorker = 'serviceWorker' in navigator;
         probe.swControllerless = 'serviceWorker' in navigator ? navigator.serviceWorker.controller === null : null;
         probe.crypto = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
         probe.webdriver = navigator.webdriver;
         probe.brands = JSON.stringify((navigator.userAgentData && navigator.userAgentData.brands) || []);
         probe.ua = navigator.userAgent.slice(0, 130);
         probe.title = document.title.slice(0, 80);
         probe.bodyChars = (document.body.textContent || '').length;
         probe.mentionsUnsupported = /unsupported|not supported|update your browser|browser.{0,20}not/i.test(document.body.textContent || '');
         return JSON.stringify(probe);
       })()`
    )
    .catch((error: unknown) => `{"threw":${JSON.stringify(String(error))}}`)) as string

  log.info(`auth probe: page reports ${capabilities}`)

  // What the page offers, structurally. Cloudflare's challenge and Google's
  // hand-off are two very different failures and they need different answers.
  const shape = (await page
    .executeJavaScript(
      `(() => {
         const frames = [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 80));
         const buttons = [...document.querySelectorAll('button, a[role=button]')]
           .map((b) => (b.textContent || '').trim().slice(0, 40))
           .filter((t) => t.length > 0)
           .slice(0, 10);
         return JSON.stringify({
           buttons,
           iframes: frames,
           cloudflare: frames.some((f) => /challenges[.]cloudflare|turnstile/i.test(f)),
           hasEmailField: !!document.querySelector('input[type=email], input[name*=email i]')
         });
       })()`
    )
    .catch(() => '{}')) as string
  log.info(`auth probe: sign-in options ${shape}`)
  log.info(`auth probe: ${failures.length} failed request(s) to the site's own origins`)
  for (const failure of failures.slice(0, 8)) log.info(`auth probe:   ${failure}`)
  log.info(`auth probe: ${messages.length} console error(s)`)
  for (const message of messages.slice(0, 10)) log.info(`auth probe:   ${message}`)

  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
