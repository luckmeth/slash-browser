import { createServer } from 'node:http'
import { app, shell } from 'electron'
import type { AppContext } from '../AppContext'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What does the sign-in actually ask for?
 *
 * The sign-in failed in a way that could be four different faults — the wrong
 * URL, a redirect the server refuses, a listener that never opened, or a
 * hand-off that went to the wrong browser — and from the outside they all look
 * like "it did not work". This prints the real authorize URL, proves the
 * loopback listener is answering, and reports which browser the hand-off would
 * go to, without needing a Google account.
 *
 * `shell.openExternal` is stubbed out so running this cannot open a browser
 * window and start a real sign-in nobody asked for.
 */
/** The active tab's contents, or null. */
function tabs0(window: BrowserWindowController): Electron.WebContents | null {
  return window.tabs.activeTab?.contents ?? null
}

export async function runRewardsSignInProbe(context: AppContext): Promise<void> {
  const original = shell.openExternal.bind(shell)
  let opened = ''
  // Intercepted rather than followed: the point is to read the URL, not to
  // begin an authorization somebody would then have to abandon.
  ;(shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (
    url: string
  ) => {
    opened = url
  }

  await context.settings.update({ rewardsEnabled: true })
  await delay(400)

  const result = await context.rewards.signIn()
  log.info(`sign-in probe: signIn() -> ${JSON.stringify(result)}`)

  // The URL is *returned* now rather than handed to the OS, because the sign-in
  // belongs in a Slash tab. `opened` staying empty is the correct behaviour and
  // is asserted rather than treated as a failure.
  log.info(`sign-in probe: handed to the OS = ${opened === '' ? 'nothing (correct)' : opened}`)
  if (opened !== '') log.error('sign-in probe: FAIL - sign-in was pushed to another browser')

  if (result.url === '') {
    log.error('sign-in probe: FAIL - no authorize URL returned')
    ;(shell as unknown as { openExternal: unknown }).openExternal = original
    app.quit()
    return
  }

  const url = new URL(result.url)
  const redirectTo = url.searchParams.get('redirect_to') ?? ''
  const challenge = url.searchParams.get('code_challenge') ?? ''
  const method = url.searchParams.get('code_challenge_method') ?? ''
  log.info(
    `sign-in probe: provider=${url.searchParams.get('provider')} redirect_to=${redirectTo} ` +
      `challenge_len=${challenge.length} method=${method}`
  )

  // Is the listener actually up on that port, and does it answer?
  if (redirectTo !== '') {
    const probeUrl = `${redirectTo}?code=probe-not-a-real-code`
    try {
      const response = await fetch(probeUrl)
      log.info(`sign-in probe: loopback answered ${response.status} at ${redirectTo}`)
    } catch (error) {
      log.error(`sign-in probe: FAIL - loopback did not answer: ${String(error)}`)
    }
  }

  // --- the interception path ------------------------------------------------
  //
  // Reproduces the **shape** of the real failure, not just its destination.
  //
  // A previous version of this probe navigated the tab straight at the dead
  // address and passed, while the real sign-in kept failing. The difference is
  // the events: a direct navigation fires `did-start-navigation`, whereas the
  // real flow arrives by **server redirect**, which fires
  // `did-redirect-navigation` instead. Testing the destination without the
  // redirect tested nothing that mattered.
  //
  // So this stands up a real server that 302s to the dead address, exactly as
  // the auth service does.
  const dead = 'http://localhost:3000/?code=probe-fake-code-1234567890'
  const bounce = createServer((_request, response) => {
    response.writeHead(302, { location: dead }).end()
  })
  await new Promise<void>((resolve) => bounce.listen(0, '127.0.0.1', resolve))
  const address = bounce.address()
  const bouncePort = address !== null && typeof address !== 'string' ? address.port : 0

  const window = context.allWindows()[0]
  const tabId = window?.tabs.snapshot().activeTabId
  if (window && tabId && bouncePort !== 0) {
    // A fresh sign-in: the loopback check above deliberately fed the listener a
    // code, which consumed the one that was pending. Without re-arming, this
    // would test nothing and still look like it passed.
    const second = await context.rewards.signIn()
    log.info(`sign-in probe: re-armed -> ok=${second.ok}`)
    if (!context.rewards.awaitingCode) {
      log.error('sign-in probe: FAIL - could not arm a sign-in to intercept')
    }

    const entry = `http://127.0.0.1:${bouncePort}/start`
    log.info(`sign-in probe: navigating to ${entry}, which 302s to ${dead}`)
    window.tabs.navigate(tabId, entry)
    await delay(5000)

    log.info(`sign-in probe: awaitingCode after = ${context.rewards.awaitingCode}`)
    log.info(
      context.rewards.awaitingCode
        ? 'sign-in probe: FAIL - the redirect was not intercepted'
        : 'sign-in probe: PASS - the code was taken from a redirected navigation'
    )
  }
  bounce.close()

  // --- the race the interception introduced -----------------------------------
  //
  // When the redirect lands on the listener as intended, the navigation watcher
  // must not finish the sign-in from the navigation event: it fires *before*
  // the HTTP request, and completing there closes the listener microseconds
  // before the browser knocks. The symptom is a connection refused on our own
  // port, which reads like the listener never opened at all.
  if (window && tabId) {
    const third = await context.rewards.signIn()
    const own = third.url === '' ? '' : new URL(third.url).searchParams.get('redirect_to') ?? ''
    if (own !== '') {
      log.info(`sign-in probe: navigating straight at the listener ${own}`)
      window.tabs.navigate(tabId, `${own}?code=probe-fake-code-1234567890`)
      await delay(4000)
      const page = tabs0(window)
      const body = page
        ? await page
            .executeJavaScript(`(document.body && document.body.innerText || '').slice(0, 120)`, true)
            .catch(() => '')
        : ''
      const served = typeof body === 'string' && /signed in|sign-in failed|finishing/i.test(body)
      log.info(`sign-in probe: listener page says ${JSON.stringify(String(body).trim())}`)
      log.info(
        served
          ? 'sign-in probe: PASS - the listener answered its own callback'
          : 'sign-in probe: FAIL - nothing answered on the listener port'
      )
    }
  }


  ;(shell as unknown as { openExternal: unknown }).openExternal = original
  await delay(500)
  app.quit()
}
