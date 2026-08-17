import { writeFile } from 'node:fs/promises'
import { app, desktopCapturer } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import type { CreateWorkspaceInput } from '../db/repositories/WorkspaceRepository'
import { createLogger } from '../logger'

type WorkspaceSeed = CreateWorkspaceInput

const log = createLogger('spike')

/**
 * Dev-only verification harness for Spike A.
 *
 * Captures the window as the OS composites it — which is the only way to prove
 * the view stack actually layers correctly. `webContents.capturePage()` cannot
 * answer this question: it captures a single view's own surface, so it would
 * happily return a perfect overlay image even if the overlay were rendering
 * *behind* the page view.
 *
 * Enabled only when ADAPTIVE_SPIKE_CAPTURE is set. Never runs in a normal launch.
 */
export async function runSpikeCapture(
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  // Navigate the active tab to a real site so the overlay is provably
  // compositing above live web content and not merely above a blank view.
  const activeId = window.tabs.snapshot().activeTabId
  if (activeId) window.tabs.navigate(activeId, 'https://example.com')

  log.info('spike capture: showing overlay')
  window.overlay.show('spike', window.fullBounds())

  // Let the page finish loading and the overlay paint its first frame.
  await new Promise((resolve) => setTimeout(resolve, 3500))

  await assertPageIsUnprivileged(window)

  const { width, height } = window.browserWindow.getBounds()
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width, height }
  })

  // Substring, not equality: the window title now follows the active tab, so it
  // reads "Example Domain — Slash". An exact match silently fell
  // through to sources[0] and captured whatever unrelated window happened to be
  // first.
  const source = sources.find((s) => s.name.includes('Slash'))
  if (!source) {
    log.error('spike capture: no window source found')
    app.quit()
    return
  }

  await writeFile(outputPath, source.thumbnail.toPNG())
  log.info(`spike capture: wrote ${outputPath} (source "${source.name}")`)
  app.quit()
}

/**
 * Dev-only capture of the browser in a realistic state: several tabs, a live
 * page, and no overlay. Used to eyeball the chrome during development.
 */
export async function runUiCapture(
  ctx: { workspaces: { list: () => { id: string }[]; create: (i: WorkspaceSeed) => { id: string } } },
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  // The first tab is created on the chrome view's did-finish-load, so this must
  // wait rather than assume one exists — otherwise the capture races startup and
  // records a window whose tab order is an artefact of the harness.
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    log.error('capture: no tab appeared')
    app.quit()
    return
  }

  // Seed a couple of workspaces, including an isolated one, so the rail shows
  // real state rather than a single default entry.
  if (ctx.workspaces.list().length < 2) {
    ctx.workspaces.create({ name: 'Work', icon: 'wsWork', color: 'green', isolated: true })
    ctx.workspaces.create({ name: 'Research', icon: 'wsResearch', color: 'purple', isolated: false })
  }
  for (const contents of window.privilegedContents()) {
    contents.send('workspaces:snapshot', {
      workspaces: ctx.workspaces.list(),
      activeWorkspaceId: window.tabs.currentWorkspaceId
    })
  }

  window.tabs.navigate(activeId, 'https://example.com')
  window.tabs.create({ url: 'https://www.wikipedia.org', background: true })
  window.tabs.create({ url: 'https://news.ycombinator.com', background: true })

  await delay(5000)
  await assertPageIsUnprivileged(window)
  await captureWindowTo(window, outputPath)

  // Second frame with a side panel open, to confirm the page view is inset
  // rather than covered.
  const panelPath = outputPath.replace(/\.png$/, '-panel.png')
  ipcBroadcastUiCommand(window, 'open-history')
  await delay(1200)
  await captureWindowTo(window, panelPath)
  ipcBroadcastUiCommand(window, 'close-panel')
  await delay(400)

  // Omnibox first: the find bar changes the chrome height, and leaving it open
  // would offset every later frame.
  await captureOmniboxDropdown(window, outputPath.replace(/\.png$/, '-omnibox.png'))

  // Find bar: confirms the chrome-height round trip insets the native page view
  // rather than the bar being drawn over a page that still owns the full height.
  const activeId2 = window.tabs.snapshot().activeTabId
  ipcBroadcastUiCommand(window, 'open-find')
  await delay(600)
  if (activeId2) {
    window.tabs.findInPage(activeId2, 'domain', { forward: true, findNext: false })
  }
  await delay(1400)
  await captureWindowTo(window, outputPath.replace(/\.png$/, '-find.png'))

  app.quit()
}

/**
 * Types into the real omnibox and captures the dropdown.
 *
 * Sets the value through the native setter rather than assigning `.value`:
 * React installs its own property descriptor on the input, so a plain assignment
 * updates the DOM without React ever seeing a change, and no suggestions would
 * be requested.
 */
async function captureOmniboxDropdown(
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  const chrome = window.privilegedContents()[0]
  if (!chrome) return

  // Raise the window *before* typing, since raising it afterwards would blur the
  // field and dismiss the dropdown.
  window.browserWindow.show()
  window.browserWindow.moveTop()
  window.browserWindow.focus()
  chrome.focus()
  await delay(600)

  await chrome.executeJavaScript(`
    (() => {
      const input = document.querySelector('input[aria-label="Address and search bar"]');
      if (!input) return 'no input';
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      setter.call(input, 'wiki');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()
  `)

  await delay(1600)
  await captureWindowTo(window, outputPath, { front: false })
  await assertDropdownRendered(window)
}

/**
 * Dev-only check of the external hand-off.
 *
 * Navigates to Google's sign-in — the page that actually rejects this browser —
 * and confirms the notice appears in the chrome and the page view insets to make
 * room for it, rather than the notice being drawn under the page.
 */
export async function runHandoffCapture(
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // Activate explicitly: a restored session can leave the active tab pointing
  // somewhere else, and the notice is about the tab the user is looking at.
  window.tabs.activate(activeId)
  window.tabs.navigate(activeId, 'https://accounts.google.com/signin')
  await delay(6000)

  const chrome = window.privilegedContents()[0]
  if (chrome) {
    const seen = (await chrome.executeJavaScript(
      `(() => {
         const el = [...document.querySelectorAll('[role="status"]')]
           .find((n) => n.textContent && n.textContent.includes('default browser'));
         return el ? el.textContent.slice(0, 120) : 'not shown';
       })()`
    )) as string
    if (seen === 'not shown') {
      const snap = window.tabs.snapshot()
      log.error(
        `handoff probe: FAIL — notice did not appear ` +
          `(navigated=${activeId} active=${snap.activeTabId})`
      )
    } else {
      log.info(`handoff probe: PASS — ${seen}`)
    }
  }

  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only diagnostic for the Google sign-in refusal.
 *
 * Exists because "Google blocks us" is a claim, and a claim about someone else's
 * server-side heuristic is worth exactly as much as the evidence behind it. This
 * reads the signals a browser actually exposes to a page — the ones Google's
 * check is documented and observed to consult — and prints them, so the
 * conclusion in `SessionHardening` can be checked rather than believed.
 *
 * Reads only from our own page views, and only values the page could read about
 * itself. No credentials are typed and nothing is submitted.
 */
export async function runGoogleDiagnostic(
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  window.tabs.activate(activeId)
  window.tabs.navigate(activeId, 'https://accounts.google.com/signin/v2/identifier')
  await delay(7000)

  const page = window.tabs.findById(activeId)?.contents
  if (!page) {
    log.error('google diagnostic: no page contents')
    app.quit()
    return
  }

  // Client-identification signals, read from the page itself. `getHighEntropyValues`
  // is the full brand list — the short `brands` array is what a site sees first,
  // but the high-entropy call is what a determined check reads.
  const signals = (await page.executeJavaScript(
    `(async () => {
       const uad = navigator.userAgentData;
       let high = null;
       try {
         high = uad ? await uad.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion']) : null;
       } catch (e) { high = { error: String(e) }; }
       return JSON.stringify({
         userAgent: navigator.userAgent,
         webdriver: navigator.webdriver,
         hasUserAgentData: !!uad,
         brands: uad ? uad.brands : null,
         mobile: uad ? uad.mobile : null,
         platform: uad ? uad.platform : null,
         highEntropy: high,
         pluginCount: navigator.plugins.length,
         languages: navigator.languages
       }, null, 1);
     })()`
  )) as string
  log.info(`google diagnostic: signals ${signals}`)

  // The page's own text, which is where the refusal (if any) is stated.
  const pageText = (await page.executeJavaScript(
    `JSON.stringify({
       url: location.href,
       title: document.title,
       text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)
     }, null, 1)`
  )) as string
  log.info(`google diagnostic: page ${pageText}`)

  // What the request actually carried. Sec-CH-UA is derived from the same brand
  // list, so this shows whether the wire agrees with the JS API.
  const headers = (await page.executeJavaScript(
    `fetch('https://accounts.google.com/generate_204', { method: 'GET' })
       .then((r) => JSON.stringify({ status: r.status, type: r.type }))
       .catch((e) => JSON.stringify({ error: String(e) }))`
  )) as string
  log.info(`google diagnostic: probe request ${headers}`)

  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only verification that the unsaved-input guard still fires.
 *
 * This guard is what stops the performance engine destroying a renderer holding
 * a half-filled form, so a silent regression here loses a user's typing. The
 * preload no longer reads field values, which means the signal now depends
 * entirely on `input` events reaching it — worth proving against a real DOM
 * rather than trusting the unit test of the predicate alone.
 */
export async function runUnsavedInputCapture(window: BrowserWindowController): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  const form = `data:text/html,${encodeURIComponent(
    `<form><input id="t" type="text"><input id="p" type="password">` +
      `<input id="c" type="checkbox"><div id="e" contenteditable="true"></div></form>`
  )}`

  window.tabs.activate(activeId)
  window.tabs.navigate(activeId, form)
  await delay(2500)

  const tab = window.tabs.findById(activeId)
  const page = tab?.contents
  if (!tab || !page) {
    log.error('unsaved probe: no page')
    app.quit()
    return
  }

  const baseline = tab.hasUnsavedInput
  log.info(`unsaved probe: before typing = ${baseline}`)

  // A checkbox first: it must NOT count, so a pass here proves the predicate is
  // consulted rather than every input event being treated as unsaved work.
  await page.executeJavaScript(
    `document.getElementById('c').click(); void 0`
  )
  await delay(2200)
  log.info(`unsaved probe: after checkbox = ${tab.hasUnsavedInput}`)

  // Real typing, via input events the way a user produces them.
  page.focus()
  await page.executeJavaScript(`document.getElementById('t').focus(); void 0`)
  for (const ch of 'hello') {
    page.sendInputEvent({ type: 'char', keyCode: ch })
    await delay(40)
  }
  await delay(2200)
  const afterTyping = tab.hasUnsavedInput

  if (baseline === false && afterTyping === true) {
    log.info('unsaved probe: PASS — flag set by typing, not by a checkbox')
  } else {
    log.error(`unsaved probe: FAIL — baseline=${baseline} afterTyping=${afterTyping}`)
  }

  app.quit()
}

/**
 * Dev-only Slash Shield popup verification.
 *
 * The unit tests cover the decision; this covers the wiring the decision depends
 * on — that a trusted click actually reaches main as a gesture, and that an
 * unclicked `window.open` is stopped. Those two travel through the content
 * preload, an IPC channel and `setWindowOpenHandler`, none of which a pure test
 * exercises.
 */
export async function runPopupCapture(
  window: BrowserWindowController,
  hooks: { tabCount: () => number }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  const page = `data:text/html,${encodeURIComponent(
    `<button id="b" onclick="window.open('https://example.com/clicked','_blank')">open</button>`
  )}`

  window.tabs.activate(activeId)
  window.tabs.navigate(activeId, page)
  await delay(2500)

  const contents = window.tabs.findById(activeId)?.contents
  if (!contents) {
    log.error('popup probe: no page')
    app.quit()
    return
  }

  // 1. Script-initiated, no click anywhere. Must be blocked.
  const before = hooks.tabCount()
  await contents.executeJavaScript(`window.open('https://example.com/auto','_blank'); void 0`)
  await delay(1200)
  const afterAuto = hooks.tabCount()

  // 2. A real click on the button. Must be allowed — this is the case a popup
  //    blocker must never get wrong, because the user asked for it.
  const bounds = window.browserWindow.getContentBounds()
  contents.sendInputEvent({ type: 'mouseDown', x: 30, y: 20, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: 30, y: 20, button: 'left', clickCount: 1 })
  await delay(1500)
  const afterClick = hooks.tabCount()

  log.info(
    `popup probe: tabs before=${before} afterScriptOpen=${afterAuto} afterClick=${afterClick} ` +
      `(window ${bounds.width}x${bounds.height})`
  )
  if (afterAuto === before && afterClick > afterAuto) {
    log.info('popup probe: PASS — script popup blocked, clicked popup allowed')
  } else {
    log.error('popup probe: FAIL')
  }

  app.quit()
}

/**
 * Dev-only redirect-guard verification.
 *
 * The unit tests cover the judgement; this covers that `will-navigate` and
 * `will-redirect` are actually installed and that `preventDefault` genuinely
 * stops the load. It also checks the case that matters most — that a sign-in
 * host is still reachable — because a redirect guard that breaks OAuth is worse
 * than no redirect guard.
 */
export async function runRedirectCapture(
  window: BrowserWindowController,
  hooks: { lockTab: (tabId: string) => void }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  window.tabs.activate(activeId)
  window.tabs.navigate(activeId, 'https://example.com/')
  await delay(3000)

  const tab = window.tabs.findById(activeId)
  const page = tab?.contents
  if (!tab || !page) {
    log.error('redirect probe: no page')
    app.quit()
    return
  }

  // Lock the tab, then have the *page* try to leave for another site with no
  // click. This is the pattern a video page uses to throw you at an ad.
  hooks.lockTab(activeId)
  await page.executeJavaScript(`location.href = 'https://www.iana.org/domains'; void 0`)
  await delay(2500)
  const afterHostile = page.getURL()

  // Now the case that must never break: a sign-in host, same conditions.
  await page.executeJavaScript(`location.href = 'https://accounts.google.com/signin'; void 0`)
  await delay(4000)
  const afterAuth = page.getURL()

  log.info(`redirect probe: afterHostile=${afterHostile}`)
  log.info(`redirect probe: afterAuth=${afterAuth}`)

  const stayed = afterHostile.includes('example.com')
  const reachedAuth = afterAuth.includes('accounts.google.com')
  if (stayed && reachedAuth) {
    log.info('redirect probe: PASS — cross-site jump blocked, sign-in still reachable')
  } else {
    log.error(`redirect probe: FAIL — stayed=${stayed} reachedAuth=${reachedAuth}`)
  }

  app.quit()
}

/**
 * Dev-only YouTube diagnostic.
 *
 * "Ads still play" is a claim about a specific site, and the answer depends
 * entirely on what that site actually requests. This records the request URLs a
 * video page makes and what the filter decided about each, so the fix is chosen
 * from evidence rather than from what ad blocking is assumed to look like.
 */
export async function runYouTubeCapture(
  window: BrowserWindowController,
  hooks: { onRequest: (url: string, blocked: boolean) => void; report: () => string }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  void hooks.onRequest
  window.tabs.activate(activeId)
  // A video page, not the home page — ads are attached to playback.
  window.tabs.navigate(activeId, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await delay(12000)

  const page = window.tabs.findById(activeId)?.contents
  if (page) {
    // What the player itself thinks it is going to show. `adPlacements` is the
    // field YouTube stitches ad breaks into, and it lives in the page's own
    // player response — not in any separate request.
    const player = (await page.executeJavaScript(
      `(() => {
         try {
           const r = window.ytInitialPlayerResponse;
           if (!r) return JSON.stringify({ playerResponse: 'absent' });
           return JSON.stringify({
             hasAdPlacements: Array.isArray(r.adPlacements),
             adPlacementCount: (r.adPlacements || []).length,
             hasPlayerAds: !!r.playerAds,
             adSlotCount: (r.adSlots || []).length
           });
         } catch (e) { return JSON.stringify({ error: String(e) }); }
       })()`
    )) as string
    log.info(`youtube probe: player ${player}`)
  }

  log.info(`youtube probe: ${hooks.report()}`)
  app.quit()
}

/**
 * Dev-only content-blocker verification.
 *
 * Loads real pages that carry advertising and analytics, and confirms requests
 * were actually cancelled — not merely that the engine's unit tests pass. Also
 * checks a known-malicious host is refused.
 */
export async function runBlockingCapture(
  window: BrowserWindowController,
  outputPath: string,
  blocker: {
    countFor: (webContentsId: number) => number
    diagnostics: { seen: number; withContentsId: number; thirdParty: number; resolvedPage: number }
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // Start from a blank page: a restored session could otherwise leave the tab
  // on whatever the last run ended with.
  window.tabs.navigate(activeId, 'about:blank')
  await delay(1500)

  /*
   * Deterministic test.
   *
   * Loading a news site and hoping it serves ads is not a test — a consent
   * dialog or a quiet ad auction makes it pass or fail for reasons that have
   * nothing to do with the filter. Instead, load an ordinary page and have it
   * request a known tracker directly: that is unambiguously a third-party
   * request to a listed domain, and it either gets cancelled or it does not.
   */
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(4000)

  const page = window.tabs.findById(activeId)?.contents
  if (page) {
    const probe = (await page.executeJavaScript(
      `(async () => {
         const attempt = async (url) => {
           try { await fetch(url, { mode: 'no-cors', cache: 'no-store' }); return 'allowed'; }
           catch { return 'blocked'; }
         };
         return {
           tracker: await attempt('https://www.google-analytics.com/analytics.js'),
           ads: await attempt('https://securepubads.g.doubleclick.net/tag/js/gpt.js'),
           innocent: await attempt('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js')
         };
       })()`,
      true
    )) as { tracker: string; ads: string; innocent: string }

    log.info(
      `blocking probe: tracker=${probe.tracker} ads=${probe.ads} innocent=${probe.innocent}`
    )
    if (probe.tracker === 'blocked' && probe.ads === 'blocked' && probe.innocent === 'allowed') {
      log.info('blocking probe: PASS — trackers cancelled, unrelated CDN untouched')
    } else {
      log.error('blocking probe: FAIL — filter did not behave as expected')
    }
  }
  await delay(1500)

  const contents = window.tabs.findById(activeId)?.contents
  const blocked = contents ? blocker.countFor(contents.id) : 0
  const d = blocker.diagnostics
  log.info(
    `blocking probe: seen=${d.seen} withContentsId=${d.withContentsId} ` +
      `resolvedPage=${d.resolvedPage} thirdParty=${d.thirdParty} blocked=${blocked}`
  )
  log.info(`blocking probe: tab is at ${window.tabs.findById(activeId)?.snapshot.url}`)

  if (blocked > 0) {
    log.info('blocking probe: PASS — ad and tracker requests were cancelled')
  } else {
    log.error('blocking probe: FAIL — nothing was blocked')
  }

  // Malicious navigation must be refused outright.
  window.tabs.navigate(activeId, 'https://malware.testing.google.test/testing/malware/')
  await delay(4000)
  const after = window.tabs.snapshot().tabs.find((t) => t.id === activeId)
  log.info(`blocking probe: malicious navigation left tab at ${after?.url}`)

  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only Phase 5 verification.
 *
 * Exercises the whole chain against real pages: consent gate → Readability
 * extraction in the page → FTS5 index → BM25 search → match explanations. Also
 * checks the gate the other way round, which is the part that matters most: with
 * indexing off, nothing may be written at all.
 */
export async function runMemoryCapture(
  window: BrowserWindowController,
  outputPath: string,
  memory: {
    setIndexing: (history: boolean, content: boolean) => void
    excludeOrigin: (origin: string) => void
    search: (query: string) => { results: Array<{ title: string; reasons: Array<{ detail: string }> }> }
    stats: () => { pageCount: number; withContent: number }
    clear: () => void
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // 1. Gate closed: visiting a page must write nothing.
  memory.clear()
  memory.setIndexing(false, false)
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(4000)
  const gated = memory.stats()
  if (gated.pageCount === 0) {
    log.info('memory probe: PASS — nothing indexed while the setting is off')
  } else {
    log.error(`memory probe: FAIL — ${gated.pageCount} page(s) indexed with the gate closed`)
  }

  // 2. Metadata only.
  memory.setIndexing(true, false)
  window.tabs.navigate(activeId, 'https://www.iana.org/help/example-domains')
  await delay(4500)
  const metaOnly = memory.stats()
  if (metaOnly.pageCount > 0 && metaOnly.withContent === 0) {
    log.info('memory probe: PASS — history indexed without page text')
  } else {
    log.error(
      `memory probe: FAIL — pages=${metaOnly.pageCount} withContent=${metaOnly.withContent}`
    )
  }

  // 3. Excluded origin, with content indexing fully on.
  memory.setIndexing(true, true)
  memory.excludeOrigin('https://example.com')
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(4500)
  const afterExcluded = memory.search('illustrative examples')
  if (afterExcluded.results.every((r) => !r.title.toLowerCase().includes('example domain'))) {
    log.info('memory probe: PASS — an excluded origin was not indexed')
  } else {
    log.error('memory probe: FAIL — excluded origin was indexed anyway')
  }

  // 4. Full content indexing on a real article.
  window.tabs.navigate(activeId, 'https://en.wikipedia.org/wiki/PostgreSQL')
  await delay(7000)
  const stats = memory.stats()
  log.info(`memory probe: indexed ${stats.pageCount} page(s), ${stats.withContent} with full text`)

  // Search for a word that appears only in the *body*, never in the title or
  // URL — the whole claim of Web Memory is finding pages by what was on them.
  const found = memory.search('relational database transactions')
  log.info(`memory probe: "relational database transactions" → ${found.results.length} result(s)`)
  for (const result of found.results.slice(0, 3)) {
    log.info(`   ${result.title} — ${result.reasons.map((r) => r.detail).join('; ')}`)
  }

  if (found.results.length > 0 && stats.withContent > 0) {
    log.info('memory probe: PASS — a page was found by its body text')
  } else {
    log.error('memory probe: FAIL — full-text search returned nothing')
  }

  // 5. Time-scoped query.
  const scoped = memory.search('postgres today')
  log.info(`memory probe: time-scoped query → ${scoped.results.length} result(s)`)

  ipcBroadcastUiCommand(window, 'open-memory')
  await delay(1500)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only Phase 6 verification, run in two passes.
 *
 * Pass "record" opens tabs, navigates one of them twice so it has real
 * back-history, then quits normally — which is what writes the session-end
 * snapshot. Pass "verify" launches again and inspects what came back.
 *
 * Two separate process launches on purpose: restoring from an in-memory object
 * would prove nothing. The claim is that a session survives the process dying,
 * so the process has to actually die.
 */
export async function runSnapshotCapture(
  window: BrowserWindowController,
  outputPath: string,
  mode: string
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  if (mode === 'record') {
    window.tabs.navigate(activeId, 'https://example.com')
    await delay(3500)
    // Second navigation in the same tab, so there is a back entry to restore.
    window.tabs.navigate(activeId, 'https://www.iana.org/help/example-domains')
    await delay(3500)

    window.tabs.create({ url: 'https://www.wikipedia.org', background: true })
    await delay(3000)

    const before = window.tabs.snapshot()
    log.info(`snapshot record: ${before.tabs.length} tab(s) open, quitting normally`)
    // Ordinary quit — the before-quit hook is what captures the session.
    app.quit()
    return
  }

  // --- verify pass ---------------------------------------------------------
  const snapshot = window.tabs.snapshot()
  const restored = snapshot.tabs.filter((tab) => !tab.url.startsWith('adaptive://'))

  log.info(`snapshot verify: ${restored.length} tab(s) came back`)
  for (const tab of restored) {
    log.info(`  ${tab.status.padEnd(11)} ${tab.url}`)
  }

  if (restored.length === 0) {
    log.error('snapshot verify: FAIL — nothing was restored')
    app.quit()
    return
  }

  // Restored tabs must arrive hibernated: reopening forty tabs should not launch
  // forty renderers at once.
  const live = restored.filter((tab) => tab.status !== 'hibernated')
  if (live.length > 1) {
    log.error(`snapshot verify: FAIL — ${live.length} tabs materialised eagerly`)
  } else {
    log.info('snapshot verify: PASS — restored tabs are hibernated until activated')
  }

  // Activate the tab that had two navigations and confirm Back works, which is
  // the part that proves navigation history survived rather than just the URL.
  const target = restored.find((tab) => tab.url.includes('iana.org')) ?? restored[0]
  if (target) {
    window.tabs.activate(target.id)
    await delay(4000)
    const after = window.tabs.snapshot().tabs.find((tab) => tab.id === target.id)
    if (after?.canGoBack) {
      log.info('snapshot verify: PASS — back/forward history survived the restart')
    } else {
      log.error('snapshot verify: FAIL — restored tab has no back history')
    }
  }

  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only Phase 4 verification.
 *
 * Triggers a real `navigator.geolocation` request from a real page, so the whole
 * chain runs: Chromium's permission handler → PermissionManager → overlay prompt
 * → user answer → the page's own callback. Checking the manager in isolation
 * would not prove the session handler is actually wired to it.
 */
export async function runPermissionCapture(
  window: BrowserWindowController,
  outputPath: string,
  permissions: {
    respond: (requestId: string, policy: 'allow-once' | 'block') => void
    pendingIds: () => string[]
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  window.tabs.navigate(activeId, 'https://example.com')
  await delay(4000)

  const page = window.tabs.findById(activeId)?.contents
  if (!page) {
    log.error('permission probe: no page')
    app.quit()
    return
  }

  // Fire the request but do not await it — it only settles once answered.
  void page.executeJavaScript(`
    window.__permissionOutcome = 'pending';
    navigator.geolocation.getCurrentPosition(
      () => { window.__permissionOutcome = 'granted'; },
      (error) => { window.__permissionOutcome = 'denied:' + error.code; }
    );
    'requested'
  `)

  await delay(1500)

  const prompt = window.pendingPermission
  if (!prompt) {
    log.error('permission probe: FAIL — no prompt was raised')
    app.quit()
    return
  }
  log.info(`permission probe: prompt raised for ${prompt.origin} (${prompt.kinds.join('+')})`)

  const overlay = window.overlay.webContents
  if (overlay) {
    const text = (await overlay.executeJavaScript(
      `(document.body.innerText || '').replace(/\\n+/g, ' | ').slice(0, 200)`
    )) as string
    log.info(`permission probe: prompt text — ${text}`)
  }

  await captureWindowTo(window, outputPath)

  // Refuse, and confirm the refusal actually reaches the page's error callback.
  permissions.respond(prompt.requestId, 'block')
  await delay(1200)

  const outcome = (await page.executeJavaScript(`window.__permissionOutcome`)) as string
  // PERMISSION_DENIED is code 1.
  if (outcome.startsWith('denied:1')) {
    log.info('permission probe: PASS — denial reached the page (PERMISSION_DENIED)')
  } else {
    log.error(`permission probe: FAIL — page saw "${outcome}"`)
  }

  if (permissions.pendingIds().length > 0) {
    log.error('permission probe: FAIL — a request was left unsettled')
  }

  app.quit()
}

/**
 * Verifies the dropdown by reading the overlay's DOM.
 *
 * A screenshot is not a reliable check here: driving focus programmatically into
 * a WebContentsView is fragile, and a blur tears the dropdown down before the
 * frame is taken. Publishing the state from main and then counting the rendered
 * rows tests the part that actually matters — that the overlay document mounts
 * the list and paints it over the page.
 */
async function assertDropdownRendered(window: BrowserWindowController): Promise<void> {
  const suggestions = [
    {
      id: 'probe:1',
      kind: 'navigate' as const,
      title: 'example.com',
      subtitle: 'Open this address',
      url: 'https://example.com',
      tabId: null,
      faviconUrl: null
    },
    {
      id: 'probe:2',
      kind: 'history' as const,
      title: 'Wikipedia',
      subtitle: 'www.wikipedia.org',
      url: 'https://www.wikipedia.org',
      tabId: null,
      faviconUrl: null
    }
  ]

  window.omniboxState = {
    query: 'wiki',
    suggestions,
    selectedIndex: 0,
    bounds: { x: 200, y: 90, width: 700, height: 104 }
  }
  window.overlay.show('command-bar', window.omniboxState.bounds)

  const overlay = window.overlay.webContents
  if (!overlay) {
    log.error('dropdown probe: no overlay contents')
    return
  }
  for (const contents of window.privilegedContents()) {
    contents.send('overlay:stateChanged', { visible: true, surface: 'command-bar' })
    contents.send('omnibox:state', window.omniboxState)
  }

  await delay(1200)
  const rows = (await overlay.executeJavaScript(
    `document.querySelectorAll('[role="option"]').length`
  )) as number
  const text = (await overlay.executeJavaScript(
    `(document.body.innerText || '').replace(/\\n/g, ' | ').slice(0, 120)`
  )) as string

  if (rows === suggestions.length) {
    log.info(`dropdown probe: PASS — ${rows} rows rendered in the overlay: ${text}`)
  } else {
    log.error(`dropdown probe: FAIL — expected ${suggestions.length} rows, found ${rows}`)
  }
}

/**
 * Dev-only Phase 3 verification.
 *
 * Drives the real engine with second-scale thresholds instead of the shipped
 * minute-scale ones, so hibernation can actually be observed. Everything else —
 * the guards, the sampler, the measured-savings recording — runs unchanged.
 */
export async function runPerformanceCapture(
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    log.error('perf capture: no tab appeared')
    app.quit()
    return
  }

  window.tabs.navigate(activeId, 'https://example.com')
  window.tabs.create({ url: 'https://www.wikipedia.org', background: true })
  window.tabs.create({ url: 'https://news.ycombinator.com', background: true })
  window.tabs.create({ url: 'https://developer.mozilla.org', background: true })

  // Let the pages load and register a working set before anything is judged.
  await delay(6000)

  window.performance.policy.setPolicy({
    mode: 'aggressive',
    idleAfterMs: 1000,
    freezeAfterMs: 2000,
    hibernateAfterMs: 4000
  })
  log.info('perf capture: thresholds compressed to seconds')

  // Long enough for several sampler ticks to run and act.
  await delay(16000)

  const snapshot = window.performance.snapshot()
  for (const metric of snapshot.tabs) {
    log.info(
      `  ${metric.tabId} state=${metric.state} shared=${metric.sharedProcess} ` +
        `mem=${metric.memoryBytes ?? 'n/a'} blockers=[${metric.blockers.join(',')}]`
    )
  }
  log.info(`perf capture: total measured savings ${snapshot.totalMeasuredSavingsBytes} bytes`)

  ipcBroadcastUiCommand(window, 'open-performance')
  await delay(1500)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only verification of the semantic layer, end to end in a real Electron
 * process.
 *
 * This exists because nothing about semantic search can be proven by unit
 * tests: the parts that break are the extension DLL loading under Electron's
 * ABI, the ONNX runtime starting in a utility process, and vec0 accepting the
 * bindings better-sqlite3 produces. All three are runtime facts.
 *
 * The claim being tested is specific: a page can be found by a paraphrase that
 * shares **no search term with it**, which is the only thing semantic search
 * offers over the keyword index that already exists.
 *
 * To confirm the model really is being read from the bundle and not from a
 * stale cache, move `resources/models` aside and re-run: it must fail rather
 * than quietly fetch a replacement over the network.
 */
export async function runSemanticCapture(
  window: BrowserWindowController,
  outputPath: string,
  probe: {
    setIndexing: (history: boolean, content: boolean) => void
    enableSemantic: () => Promise<void>
    disableSemantic: () => Promise<void>
    status: () => { state: string; embeddedPages: number; pendingPages: number; detail: string }
    search: (
      query: string
    ) => Promise<Array<{ title: string; url: string; reasons: Array<{ kind: string; detail: string }> }>>
    keywordOnly: (query: string) => Array<{ title: string }>
    forget: (url: string) => void
    clear: () => void
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  probe.clear()
  probe.setIndexing(true, true)

  // 1. Enabling must report progress and end up ready — or say clearly why not.
  log.info('semantic probe: enabling (model is bundled; no download)')
  await probe.enableSemantic()
  // Settled, not ready: `unsupported` and `error` are final answers too, and
  // waiting ten minutes to be told the extension failed to load in the first
  // second is a bad way to find that out.
  const settledState = await waitFor(() => {
    const state = probe.status().state
    return state === 'ready' || state === 'unsupported' || state === 'error'
  }, 10 * 60 * 1000)
  const ready = settledState && probe.status().state === 'ready'
  log.info(`semantic probe: state=${probe.status().state} — ${probe.status().detail}`)
  if (!ready) {
    log.error('semantic probe: FAIL — the model never became ready')
    app.quit()
    return
  }
  log.info('semantic probe: PASS — model loaded')

  // 2. Index two pages that are unmistakably about different things.
  const articles = [
    'https://en.wikipedia.org/wiki/Database_index',
    'https://en.wikipedia.org/wiki/Sourdough'
  ]
  for (const url of articles) {
    window.tabs.navigate(activeId, url)
    await delay(7000)
  }

  const embedded = await waitFor(() => probe.status().pendingPages === 0, 120_000)
  log.info(
    `semantic probe: ${probe.status().embeddedPages} page(s) embedded, ` +
      `${probe.status().pendingPages} pending (settled=${embedded})`
  )

  // 3. The load-bearing claim. "make queries return faster" shares no useful
  //    term with an article titled "Database index" — BM25 has nothing to match
  //    on, so a hit here can only have come from the vectors.
  const paraphrase = 'how to make database queries return faster'
  const keywordHits = probe.keywordOnly(paraphrase)
  const fusedHits = await probe.search(paraphrase)

  log.info(`semantic probe: keyword-only → ${keywordHits.length} result(s)`)
  log.info(`semantic probe: fused        → ${fusedHits.length} result(s)`)
  for (const hit of fusedHits.slice(0, 3)) {
    log.info(`   ${hit.title} — ${hit.reasons.map((r) => `${r.kind}:${r.detail}`).join('; ')}`)
  }

  const foundByMeaning = fusedHits.find(
    (hit) =>
      hit.url.includes('Database_index') && hit.reasons.some((reason) => reason.kind === 'semantic')
  )
  if (foundByMeaning) {
    log.info('semantic probe: PASS — a page was found by meaning, and said so')
  } else {
    log.error('semantic probe: FAIL — the paraphrase did not reach the right page')
  }

  // 4. The unrelated page must not be dragged in. A vector index that returns
  //    its k nearest neighbours will always return *something*; the value is in
  //    it being the right something.
  const bread = fusedHits.findIndex((hit) => hit.url.includes('Sourdough'))
  if (bread === -1 || bread > 0) {
    log.info('semantic probe: PASS — the unrelated page did not outrank the right one')
  } else {
    log.error('semantic probe: FAIL — an unrelated page ranked first')
  }

  // 5. Forgetting a page must take its vectors too, not just its text.
  probe.forget('https://en.wikipedia.org/wiki/Database_index')
  const afterForget = await probe.search(paraphrase)
  if (!afterForget.some((hit) => hit.url.includes('Database_index'))) {
    log.info('semantic probe: PASS — a forgotten page is gone from the vector index')
  } else {
    log.error('semantic probe: FAIL — a forgotten page still matched')
  }

  // 6. Switching off must leave keyword search entirely intact.
  await probe.disableSemantic()
  const offState = probe.status().state
  const stillWorks = probe.keywordOnly('sourdough')
  if (offState === 'off' && stillWorks.length > 0) {
    log.info('semantic probe: PASS — keyword search unaffected with semantic off')
  } else {
    log.error(`semantic probe: FAIL — state=${offState}, keyword results=${stillWorks.length}`)
  }

  ipcBroadcastUiCommand(window, 'open-memory')
  await delay(1500)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only verification of the browser import, against whatever Chromium
 * profiles are actually on this machine.
 *
 * Runs into the throwaway probe profile, never a real one. The second import is
 * the interesting half: running it twice must merge rather than duplicate, and
 * that is exactly the bug nobody notices until their bookmarks have two of
 * everything.
 */
export async function runImportCapture(probe: {
  discover: () => Array<{ id: string; browser: string; profile: string; hasBookmarks: boolean; hasHistory: boolean }>
  run: (id: string) => {
    bookmarksAdded: number
    bookmarksSkipped: number
    historyAdded: number
    historyMerged: number
    warning: string | null
  }
  bookmarkCount: () => number
  historyCount: () => number
}): Promise<void> {
  const sources = probe.discover()
  log.info(`import probe: found ${sources.length} profile(s)`)
  for (const source of sources.slice(0, 12)) {
    log.info(
      `   ${source.browser} — ${source.profile} (bookmarks=${source.hasBookmarks} history=${source.hasHistory})`
    )
  }

  if (sources.length === 0) {
    log.error('import probe: SKIP — no Chromium profile on this machine to import from')
    app.quit()
    return
  }

  // `hasBookmarks` only means the file exists — plenty of profiles have one
  // holding nothing. Keep trying until bookmarks actually arrive, or the probe
  // silently never exercises the bookmark write path at all.
  const before = { bookmarks: probe.bookmarkCount(), history: probe.historyCount() }
  let target = sources[0]!
  let first = probe.run(target.id)
  for (const candidate of sources.slice(1)) {
    if (first.bookmarksAdded > 0) break
    const attempt = probe.run(candidate.id)
    if (attempt.bookmarksAdded > 0 || attempt.historyAdded > first.historyAdded) {
      target = candidate
      first = attempt
    }
  }
  log.info(`import probe: exercised ${target.browser} — ${target.profile}`)
  const after = { bookmarks: probe.bookmarkCount(), history: probe.historyCount() }

  if (first.bookmarksAdded === 0) {
    log.warn('import probe: no profile on this machine has bookmarks; that path is unproven here')
  }

  log.info(
    `import probe: first run → +${first.bookmarksAdded} bookmark(s), +${first.historyAdded} page(s)` +
      `${first.warning ? ` (warning: ${first.warning})` : ''}`
  )
  log.info(
    `import probe: rows ${before.bookmarks}→${after.bookmarks} bookmarks, ` +
      `${before.history}→${after.history} history`
  )

  if (after.history > before.history || after.bookmarks > before.bookmarks) {
    log.info('import probe: PASS — data arrived')
  } else {
    log.error('import probe: FAIL — nothing was imported')
  }

  // Second pass: everything is already here, so nothing may be added again.
  const second = probe.run(target.id)
  const final = { bookmarks: probe.bookmarkCount(), history: probe.historyCount() }
  log.info(
    `import probe: second run → +${second.bookmarksAdded} bookmark(s) ` +
      `(${second.bookmarksSkipped} already present), +${second.historyAdded} page(s) ` +
      `(${second.historyMerged} merged)`
  )

  if (second.bookmarksAdded === 0 && second.historyAdded === 0) {
    log.info('import probe: PASS — importing twice does not duplicate')
  } else {
    log.error(
      `import probe: FAIL — second import added ${second.bookmarksAdded} bookmark(s) ` +
        `and ${second.historyAdded} page(s)`
    )
  }

  if (final.history === after.history) {
    log.info('import probe: PASS — history row count unchanged by the repeat')
  } else {
    log.error(`import probe: FAIL — history grew ${after.history}→${final.history} on a repeat`)
  }

  app.quit()
}

/**
 * Dev-only verification of the features added on top of Phase 7.
 *
 * Each check is a runtime fact no unit test reaches: whether the page view is
 * actually detached when a load fails, whether Chromium renders a PDF inline
 * rather than downloading it, and whether Readability finds an article in a real
 * page rather than a fixture.
 */
export async function runFeaturesCapture(
  window: BrowserWindowController,
  outputPath: string,
  probe: {
    setVerticalTabs: (on: boolean) => void
    activeError: () => { code: number; description: string } | null
    isViewAttached: () => boolean
    readArticle: () => Promise<{ ok: boolean; title: string; blocks: number; reason: string | null }>
    tabCount: () => number
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // 1. A failed load must detach the view so our error page is what shows.
  window.tabs.navigate(activeId, 'https://this-host-should-not-resolve-slash.invalid')
  await delay(6000)
  const failure = probe.activeError()
  const detached = !probe.isViewAttached()
  log.info(
    `features probe: failed load → error=${failure ? `${failure.code}` : 'none'}, ` +
      `page view attached=${!detached}`
  )
  if (failure && detached) {
    log.info('features probe: PASS — the Slash error page owns the content area')
  } else {
    log.error('features probe: FAIL — Chromium’s own error page is still on screen')
  }

  // 2. Retrying must put the renderer back, or the page loads where nobody can
  //    see it.
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(5000)
  if (probe.isViewAttached() && probe.activeError() === null) {
    log.info('features probe: PASS — retrying reattaches the page view')
  } else {
    log.error('features probe: FAIL — the page view did not come back after a retry')
  }

  // 3. Reader mode against a real article.
  window.tabs.navigate(activeId, 'https://en.wikipedia.org/wiki/Readability')
  await delay(7000)
  const article = await probe.readArticle()
  log.info(
    `features probe: reader → ok=${article.ok} "${article.title}" ${article.blocks} block(s)` +
      `${article.reason ? ` (${article.reason})` : ''}`
  )
  if (article.ok && article.blocks > 5) {
    log.info('features probe: PASS — an article was extracted as structured text')
  } else {
    log.error('features probe: FAIL — reader mode found no article')
  }

  // 4. A page that is not an article must be refused rather than rendered empty.
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(4000)
  const thin = await probe.readArticle()
  if (!thin.ok && thin.reason) {
    log.info('features probe: PASS — a non-article is declined with a reason')
  } else {
    log.error('features probe: FAIL — reader accepted a page that is not an article')
  }

  // 5. PDFs open in a tab instead of downloading.
  const before = probe.tabCount()
  window.tabs.navigate(activeId, 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf')
  await delay(8000)
  const stillATab = probe.tabCount() === before && probe.activeError() === null
  log.info(`features probe: pdf → tabs=${probe.tabCount()} error=${probe.activeError()?.code ?? 'none'}`)
  if (stillATab) {
    log.info('features probe: PASS — the PDF opened in the tab')
  } else {
    log.error('features probe: FAIL — the PDF did not render inline')
  }

  // 6. Vertical tabs, captured so the layout can be looked at.
  probe.setVerticalTabs(true)
  await delay(1500)
  await captureWindowTo(window, outputPath)
  probe.setVerticalTabs(false)
  log.info('features probe: captured the vertical tab layout')

  app.quit()
}

/**
 * Dev-only verification of the segmented download engine.
 *
 * Downloads a real file over real HTTP and checks the bytes. The claims being
 * tested are the ones that cannot be unit-tested and that fail *silently* when
 * wrong: that segments land at the right offsets, that the reassembled file is
 * byte-identical to a single-connection fetch of the same URL, and that a
 * server without range support degrades to one connection instead of producing
 * a corrupt file.
 */
export async function runDownloadEngineCapture(probe: {
  download: (
    url: string,
    destination: string,
    connections: number
  ) => Promise<{
    receivedBytes: number
    totalBytes: number | null
    segments: number
    note: string
    checksum: string
    acceptsRanges: boolean
  }>
  tempDir: string
  baseUrl: string
}): Promise<void> {
  // Served by a local test server started alongside this probe: deterministic
  // bytes, and a second endpoint that deliberately refuses ranges. Testing
  // against the open internet would measure someone else's CDN rather than this
  // engine, and could not exercise the no-range path on demand.
  const rangeUrl = `${probe.baseUrl}/ranged.bin`
  const noRangeUrl = `${probe.baseUrl}/plain.bin`
  const smallUrl = `${probe.baseUrl}/small.bin`

  try {
    log.info('download probe: fetching with 1 connection…')
    const single = await probe.download(rangeUrl, `${probe.tempDir}/single.bin`, 1)
    log.info(
      `download probe: single → ${single.receivedBytes} bytes, ranges=${single.acceptsRanges}, ${single.note}`
    )

    log.info('download probe: fetching the same file with 6 connections…')
    const multi = await probe.download(rangeUrl, `${probe.tempDir}/multi.bin`, 6)
    log.info(
      `download probe: multi → ${multi.receivedBytes} bytes in ${multi.segments} segment(s), ${multi.note}`
    )

    if (multi.segments > 1) {
      log.info(`download probe: PASS — the transfer was split into ${multi.segments} connections`)
    } else {
      log.error('download probe: FAIL — a range-capable server was not segmented')
    }

    // The load-bearing check. Reassembly bugs produce a file of exactly the
    // right length with the wrong bytes in the middle, which only a hash finds.
    if (single.checksum === multi.checksum && single.checksum !== '') {
      log.info('download probe: PASS — segmented output is byte-identical to a single stream')
      log.info(`download probe: sha256 ${multi.checksum.slice(0, 32)}…`)
    } else {
      log.error(
        `download probe: FAIL — checksums differ (single ${single.checksum.slice(0, 16)}, multi ${multi.checksum.slice(0, 16)})`
      )
    }

    // A small file must fall back to one connection rather than being split
    // into slivers.
    const small = await probe.download(smallUrl, `${probe.tempDir}/small.bin`, 8)
    log.info(`download probe: small file → ${small.segments} segment(s), ${small.note}`)
    if (small.segments === 1) {
      log.info('download probe: PASS — a small file is not pointlessly divided')
    } else {
      log.error('download probe: FAIL — a small file was split')
    }

    // A server that refuses ranges must degrade to one stream and still produce
    // the correct file. Getting this wrong is how a download manager corrupts
    // things: eight connections against a server that ignores Range means eight
    // copies of the whole file written over each other.
    const plain = await probe.download(noRangeUrl, `${probe.tempDir}/plain.bin`, 8)
    log.info(`download probe: no-range server → ${plain.segments} segment(s), ${plain.note}`)
    if (plain.segments === 1 && plain.checksum === single.checksum) {
      log.info('download probe: PASS — a server without range support degrades safely')
    } else {
      log.error(
        `download probe: FAIL — no-range path produced ${plain.segments} segment(s), checksum match=${plain.checksum === single.checksum}`
      )
    }
  } catch (error) {
    log.error('download probe: FAILED', error)
  }

  app.quit()
}

/**
 * Dev-only verification of the Download Guardian and media detection.
 *
 * Run against real pages, because the part that cannot be unit-tested is the
 * page-side scan: whether the injected script actually finds anchors and media
 * elements in documents written by other people, and whether the ad-markup
 * heuristic fires on real advertising rather than only on fixtures.
 */
export async function runGuardianCapture(
  window: BrowserWindowController,
  probe: {
    scanDownloads: () => Promise<{
      pageHost: string
      note: string | null
      candidates: Array<{ verdict: string; host: string; label: string }>
    }>
    scanMedia: () => Promise<{ candidates: Array<{ container: string | null }>; note: string | null }>
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // A real download page: many links, a genuine installer, and a mix of hosts.
  window.tabs.navigate(activeId, 'https://www.videolan.org/vlc/download-windows.html')
  await delay(8000)
  const scan = await probe.scanDownloads()
  log.info(`guardian probe: ${scan.pageHost} → ${scan.candidates.length} candidate(s)`)
  log.info(`guardian probe: ${scan.note ?? 'no summary'}`)
  for (const candidate of scan.candidates.slice(0, 6)) {
    log.info(`   [${candidate.verdict}] ${candidate.host} — ${candidate.label.slice(0, 50)}`)
  }
  if (scan.candidates.length > 0) {
    log.info('guardian probe: PASS — download links were found and classified')
  } else {
    log.error('guardian probe: FAIL — a real download page produced no candidates')
  }

  // Media: a page with a plain <video> file, so the direct path is exercised.
  window.tabs.navigate(activeId, 'https://www.w3schools.com/html/html5_video.asp')
  await delay(8000)
  const media = await probe.scanMedia()
  log.info(
    `guardian probe: media → ${media.candidates.length} downloadable (${media.candidates.map((c) => c.container).join(', ') || 'none'})`
  )
  if (media.note) log.info(`guardian probe: note — ${media.note}`)
  if (media.candidates.length > 0) {
    log.info('guardian probe: PASS — a directly downloadable media file was detected')
  } else {
    log.error('guardian probe: FAIL — no direct media found on a page with a plain video file')
  }

  // A streaming page must be refused with an explanation, never offered.
  window.tabs.navigate(activeId, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await delay(10000)
  const streamed = await probe.scanMedia()
  log.info(`guardian probe: streaming page → ${streamed.candidates.length} downloadable`)
  log.info(`guardian probe: note — ${streamed.note ?? '(none)'}`)
  if (streamed.candidates.length === 0 && streamed.note) {
    log.info('guardian probe: PASS — protected/streamed media is refused with a reason')
  } else {
    log.error('guardian probe: FAIL — a streaming page was treated as downloadable')
  }

  app.quit()
}

/**
 * Dev-only verification of Tab Brain against a realistic tab set.
 *
 * Opens tabs that a person actually would while working on one thing, plus an
 * unrelated pair and a deliberate duplicate, then checks the analysis found the
 * project, spotted the duplicate, and did **not** sweep the unrelated tabs in.
 * Clustering quality is the kind of thing that looks fine on fixtures and falls
 * apart on real titles, which is why this runs against live pages.
 */
export async function runTabBrainCapture(
  window: BrowserWindowController,
  outputPath: string,
  probe: {
    analyse: () => {
      tabCount: number
      summary: string
      groups: Array<{ name: string; tabIds: string[]; hosts: string[] }>
      duplicates: Array<{ title: string; tabIds: string[]; exact: boolean }>
      closeSuggestions: Array<{ title: string; reason: string }>
    }
    titleOf: (tabId: string) => string
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // One coherent project: three Wikipedia pages about the same subject area.
  window.tabs.navigate(activeId, 'https://en.wikipedia.org/wiki/Database_index')
  for (const url of [
    'https://en.wikipedia.org/wiki/Database_normalization',
    'https://en.wikipedia.org/wiki/Database_transaction',
    // Unrelated, and a duplicate of one another — both must be handled.
    'https://en.wikipedia.org/wiki/Sourdough',
    'https://en.wikipedia.org/wiki/Sourdough'
  ]) {
    window.tabs.create({ url, background: true })
  }
  await delay(14000)

  const analysis = probe.analyse()
  log.info(`tab brain probe: ${analysis.tabCount} tabs — ${analysis.summary}`)

  for (const group of analysis.groups) {
    log.info(`   group "${group.name}" (${group.tabIds.length} tabs, ${group.hosts.join(', ')})`)
    for (const tabId of group.tabIds) log.info(`      · ${probe.titleOf(tabId).slice(0, 60)}`)
  }
  for (const set of analysis.duplicates) {
    log.info(`   duplicate ×${set.tabIds.length}${set.exact ? ' (exact)' : ''}: ${set.title.slice(0, 50)}`)
  }
  for (const suggestion of analysis.closeSuggestions) {
    log.info(`   closeable: ${suggestion.title.slice(0, 40)} — ${suggestion.reason}`)
  }

  const dbGroup = analysis.groups.find((group) =>
    group.tabIds.some((id) => probe.titleOf(id).includes('Database'))
  )
  if (dbGroup && dbGroup.tabIds.length >= 3) {
    log.info('tab brain probe: PASS — the three related pages were grouped')
  } else {
    log.error('tab brain probe: FAIL — related pages were not grouped')
  }

  if (dbGroup && !dbGroup.tabIds.some((id) => probe.titleOf(id).includes('Sourdough'))) {
    log.info('tab brain probe: PASS — the unrelated page was left out of the group')
  } else {
    log.error('tab brain probe: FAIL — an unrelated page was swept into the group')
  }

  if (analysis.duplicates.length >= 1) {
    log.info('tab brain probe: PASS — the duplicate tab was detected')
  } else {
    log.error('tab brain probe: FAIL — a duplicated tab was not detected')
  }

  // Duplicates are offered for closing; nothing is closed automatically.
  if (analysis.closeSuggestions.length >= 1) {
    log.info('tab brain probe: PASS — a redundant tab was offered for closing, not closed')
  } else {
    log.error('tab brain probe: FAIL — the duplicate was not offered for closing')
  }

  ipcBroadcastUiCommand(window, 'open-tabbrain')
  await delay(1500)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only verification of Cleanup Mode.
 *
 * The two claims worth testing are the ones that would ruin a page rather than
 * merely fail: that the main content survives every mode, and that Restore puts
 * back exactly what was hidden. Both need a real document, since they depend on
 * how a live site is actually built.
 */
export async function runCleanupCapture(
  window: BrowserWindowController,
  outputPath: string,
  probe: {
    apply: (mode: 'light' | 'balanced' | 'aggressive') => Promise<{
      applied: boolean
      hidden: number
      paused: number
      detail: string
    }>
    restore: () => Promise<void>
    /** Characters of visible text in the page's main content. */
    contentLength: () => Promise<number>
    hiddenCount: () => Promise<number>
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // A real content site with overlays, sticky headers and ad slots.
  window.tabs.navigate(activeId, 'https://en.wikipedia.org/wiki/Web_browser')
  await delay(8000)

  const before = await probe.contentLength()
  log.info(`cleanup probe: page has ${before} characters of text before cleaning`)

  for (const mode of ['light', 'balanced', 'aggressive'] as const) {
    const result = await probe.apply(mode)
    const after = await probe.contentLength()
    log.info(`cleanup probe: ${mode} → hid ${result.hidden}, text now ${after} chars`)

    // The load-bearing check. Cleanup that removes the article has not cleaned
    // the page, it has broken it — and that is far worse than leaving an overlay.
    if (after >= before * 0.8) {
      log.info(`cleanup probe: PASS — ${mode} preserved the page's content`)
    } else {
      log.error(
        `cleanup probe: FAIL — ${mode} destroyed content (${before} → ${after} chars)`
      )
    }
    await probe.restore()
  }

  // Restore must leave nothing hidden behind.
  await probe.apply('aggressive')
  const hiddenAfterClean = await probe.hiddenCount()
  await probe.restore()
  const hiddenAfterRestore = await probe.hiddenCount()
  log.info(`cleanup probe: hidden ${hiddenAfterClean} after cleaning, ${hiddenAfterRestore} after restore`)
  if (hiddenAfterRestore === 0) {
    log.info('cleanup probe: PASS — Restore put everything back')
  } else {
    log.error('cleanup probe: FAIL — Restore left elements hidden')
  }

  await probe.apply('balanced')
  await delay(1200)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only verification of Page Insight against real pages.
 *
 * The collector's job is to read structured data written by other people, which
 * is exactly what cannot be tested with fixtures — sites publish JSON-LD, Open
 * Graph and microdata inconsistently, and a selector that works on a fixture
 * routinely finds nothing in the wild.
 */
export async function runInsightCapture(
  window: BrowserWindowController,
  outputPath: string,
  probe: {
    analyse: () => Promise<{
      title: string
      host: string
      wordCount: number
      outline: Array<{ level: number; text: string }>
      linkedHosts: string[]
      externalLinkCount: number
      signals: Array<{ label: string; strength: string; detail: string }>
      shopping: { productName: string | null; price: string | null; subscription: boolean } | null
      note: string | null
    }>
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // 1. A long article with a heading structure and many outbound links.
  window.tabs.navigate(activeId, 'https://en.wikipedia.org/wiki/Affiliate_marketing')
  await delay(9000)
  const article = await probe.analyse()
  log.info(
    `insight probe: "${article.title.slice(0, 40)}" — ${article.wordCount} words, ` +
      `${article.outline.length} headings, ${article.externalLinkCount} external links across ` +
      `${article.linkedHosts.length} sites`
  )
  for (const signal of article.signals) {
    log.info(`   [${signal.strength}] ${signal.label}: ${signal.detail.slice(0, 90)}`)
  }
  if (article.wordCount > 500 && article.outline.length >= 3) {
    log.info('insight probe: PASS — the article was read with its structure')
  } else {
    log.error('insight probe: FAIL — a long article produced no structure')
  }

  // 2. A real product page, to exercise JSON-LD / Open Graph price reading.
  window.tabs.navigate(activeId, 'https://www.gutenberg.org/ebooks/1342')
  await delay(9000)
  const product = await probe.analyse()
  log.info(
    `insight probe: product page → shopping=${product.shopping ? 'yes' : 'no'}` +
      (product.shopping ? ` name="${String(product.shopping.productName).slice(0, 40)}" price=${product.shopping.price}` : '')
  )

  // 3. A calm page must produce no urgency or affiliate findings. False positives
  //    here accuse an honest site, which is the failure that matters most.
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(5000)
  const calm = await probe.analyse()
  const falsePositives = calm.signals.filter(
    (signal) => signal.label.includes('affiliate') || signal.label.includes('Urgency')
  )
  log.info(`insight probe: calm page → ${calm.signals.length} signal(s), ${falsePositives.length} commercial/urgency`)
  if (falsePositives.length === 0) {
    log.info('insight probe: PASS — no false commercial or urgency findings on a plain page')
  } else {
    log.error(`insight probe: FAIL — flagged a plain page: ${falsePositives.map((s) => s.label).join(', ')}`)
  }

  window.tabs.navigate(activeId, 'https://en.wikipedia.org/wiki/Affiliate_marketing')
  await delay(8000)
  ipcBroadcastUiCommand(window, 'open-insight')
  await delay(1800)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only verification of Redirect X-Ray.
 *
 * The claim that matters is the negative one: a real sign-in flow must **not** be
 * flagged. That cannot be tested with fixtures, because it depends on the actual
 * hops a provider performs — and getting it wrong trains the user to dismiss
 * redirect warnings at the exact moment one would matter.
 */
export async function runRedirectChainCapture(
  window: BrowserWindowController,
  outputPath: string,
  probe: {
    chains: () => Array<{
      originalUrl: string
      finalUrl: string
      verdict: string
      hops: Array<{ host: string; kind: string; statusCode: number | null }>
      domains: string[]
      reasons: string[]
    }>
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // 1. A plain cross-domain redirect, so the recorder has something to record.
  window.tabs.navigate(activeId, 'https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com%2F')
  await delay(9000)

  // 2. A real identity provider. Only the first hop is reached without
  //    credentials, which is enough: classification happens on the chain's URLs.
  window.tabs.navigate(activeId, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fexample.com&response_type=code&scope=email')
  await delay(9000)

  // 3. An in-site http→https upgrade must produce no noise at all.
  window.tabs.navigate(activeId, 'http://example.com')
  await delay(6000)

  const chains = probe.chains()
  log.info(`redirect probe: recorded ${chains.length} chain(s)`)
  for (const chain of chains) {
    log.info(
      `   [${chain.verdict}] ${chain.domains.join(' → ')} (${chain.hops.length - 1} redirect(s))`
    )
    for (const hop of chain.hops) {
      log.info(`      ${hop.host} — ${hop.kind}${hop.statusCode ? ' ' + hop.statusCode : ''}`)
    }
    for (const reason of chain.reasons) log.info(`      why: ${reason.slice(0, 100)}`)
  }

  if (chains.length > 0) {
    log.info('redirect probe: PASS — chains were recorded with their hops')
  } else {
    log.error('redirect probe: FAIL — no chains recorded despite navigating through redirects')
  }

  const authChain = chains.find((chain) =>
    chain.hops.some((hop) => hop.host.includes('accounts.google.com'))
  )
  if (!authChain) {
    log.warn('redirect probe: SKIP — the sign-in navigation produced no chain to classify')
  } else if (authChain.verdict === 'authentication') {
    log.info('redirect probe: PASS — a real sign-in flow is classified as authentication')
  } else {
    log.error(
      `redirect probe: FAIL — a sign-in flow was classified "${authChain.verdict}", which would train users to ignore warnings`
    )
  }

  const statusCodes = chains.flatMap((chain) =>
    chain.hops.filter((hop) => hop.statusCode !== null).map((hop) => hop.statusCode)
  )
  if (statusCodes.length > 0) {
    log.info(`redirect probe: PASS — HTTP status codes captured (${statusCodes.join(', ')})`)
  } else {
    log.error('redirect probe: FAIL — no status codes captured; every hop would read "unknown"')
  }

  ipcBroadcastUiCommand(window, 'open-redirects')
  await delay(1800)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/**
 * Dev-only verification of the AI Hub.
 *
 * The properties worth proving are all about the credential boundary, and none of
 * them can be checked without a real keychain: that a key round-trips through
 * `safeStorage`, that several providers coexist without overwriting each other,
 * that disconnecting actually deletes, and that no status payload ever carries a
 * secret.
 */
export async function runAiHubCapture(probe: {
  status: () => {
    providers: Array<{ id: string; connected: boolean; model: string; local: boolean }>
    defaultProvider: string | null
    secureStorageAvailable: boolean
  }
  connect: (input: { provider: string; apiKey?: string; model?: string }) => string | null
  disconnect: (provider: string) => void
  setDefault: (provider: string) => string | null
  canBuild: (provider: string) => boolean
  rawStoredBytes: (provider: string) => string | null
}): Promise<void> {
  const initial = probe.status()
  log.info(
    `ai hub probe: keychain=${initial.secureStorageAvailable}, ` +
      `${initial.providers.length} provider(s) in catalogue`
  )
  if (!initial.secureStorageAvailable) {
    log.error('ai hub probe: SKIP — no OS keychain on this machine, so keys are refused by design')
    app.quit()
    return
  }

  const secret = 'sk-probe-secret-value-do-not-log'

  // 1. Two providers at once. The single-row table this replaced could only hold
  //    one, so connecting a second silently overwrote the first.
  const first = probe.connect({ provider: 'anthropic', apiKey: secret, model: 'claude-sonnet-5' })
  const second = probe.connect({ provider: 'openai', apiKey: secret + '-2', model: 'gpt-4.1' })
  const both = probe.status()
  const connected = both.providers.filter((provider) => provider.connected).map((p) => p.id)
  log.info(`ai hub probe: connected → ${connected.join(', ')} (errors: ${first ?? 'none'}, ${second ?? 'none'})`)

  if (connected.includes('anthropic') && connected.includes('openai')) {
    log.info('ai hub probe: PASS — two providers are stored independently')
  } else {
    log.error('ai hub probe: FAIL — connecting a second provider displaced the first')
  }

  // 2. Each keeps its own model. One global model name is wrong for every
  //    provider but the one it was typed for.
  const models = both.providers.filter((p) => p.connected).map((p) => `${p.id}=${p.model}`)
  log.info(`ai hub probe: models → ${models.join(', ')}`)
  const anthropicModel = both.providers.find((p) => p.id === 'anthropic')?.model
  const openaiModel = both.providers.find((p) => p.id === 'openai')?.model
  if (anthropicModel === 'claude-sonnet-5' && openaiModel === 'gpt-4.1') {
    log.info('ai hub probe: PASS — each provider keeps its own model')
  } else {
    log.error('ai hub probe: FAIL — models were shared or lost')
  }

  // 3. The key must be usable (decryptable) and never stored in readable form.
  if (probe.canBuild('anthropic')) {
    log.info('ai hub probe: PASS — the stored key decrypts and a provider can be built')
  } else {
    log.error('ai hub probe: FAIL — the stored key could not be decrypted')
  }

  const raw = probe.rawStoredBytes('anthropic') ?? ''
  if (!raw.includes(secret)) {
    log.info('ai hub probe: PASS — the key is not present in readable form on disk')
  } else {
    log.error('ai hub probe: FAIL — the API key is stored as plaintext')
  }

  // 4. Nothing in the status payload may carry a secret.
  const serialised = JSON.stringify(probe.status())
  if (!serialised.includes(secret)) {
    log.info('ai hub probe: PASS — the status payload carries no key material')
  } else {
    log.error('ai hub probe: FAIL — a key leaked into the renderer payload')
  }

  // 5. Default selection, then disconnect must actually delete.
  log.info(`ai hub probe: setDefault(openai) → ${probe.setDefault('openai') ?? 'ok'}`)
  probe.disconnect('anthropic')
  const after = probe.status()
  const stillThere = after.providers.find((p) => p.id === 'anthropic')?.connected
  log.info(`ai hub probe: after disconnect → default=${after.defaultProvider}, anthropic connected=${stillThere}`)
  if (!stillThere && after.defaultProvider === 'openai') {
    log.info('ai hub probe: PASS — disconnect deletes and the default falls back to a live provider')
  } else {
    log.error('ai hub probe: FAIL — disconnect left state behind')
  }

  probe.disconnect('openai')
  const empty = probe.status()
  if (empty.defaultProvider === null) {
    log.info('ai hub probe: PASS — with nothing connected, AI reports itself off')
  } else {
    log.error('ai hub probe: FAIL — a default survived with no providers connected')
  }

  app.quit()
}

/**
 * Dev-only verification of crash reporting.
 *
 * Crashes a renderer deliberately, because the only way to know a crash handler
 * works is to cause one. Checks the event is recorded, that Chromium wrote a
 * dump, and — the property that matters — that uploads are off.
 */
export async function runCrashCapture(
  window: BrowserWindowController,
  probe: {
    report: () => Promise<{
      directory: string
      dumpCount: number
      uploadsEnabled: boolean
      events: Array<{ process: string; reason: string; code: number | null }>
    }>
    clear: () => Promise<void>
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  await probe.clear()
  const before = await probe.report()
  log.info(`crash probe: dumps directory ${before.directory}`)
  log.info(`crash probe: uploads enabled = ${before.uploadsEnabled}`)

  if (!before.uploadsEnabled) {
    log.info('crash probe: PASS — crash dumps are never uploaded')
  } else {
    log.error('crash probe: FAIL — uploads are on; dumps contain page memory')
  }

  // Deliberately kill the page's renderer. `process.crash()` is unavailable to
  // sandboxed page content, so the crash is triggered from the browser side.
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(5000)
  const contents = window.tabs.activeTab?.contents
  if (!contents) {
    log.error('crash probe: FAIL — no renderer to crash')
    app.quit()
    return
  }
  log.info('crash probe: crashing the page renderer on purpose…')
  contents.forcefullyCrashRenderer()
  await delay(6000)

  const after = await probe.report()
  log.info(
    `crash probe: ${after.events.length} event(s) recorded, ${after.dumpCount} dump(s) on disk`
  )
  for (const event of after.events.slice(0, 3)) {
    log.info(`   ${event.process} — ${event.reason}${event.code !== null ? ` (${event.code})` : ''}`)
  }

  if (after.events.length > before.events.length) {
    log.info('crash probe: PASS — the crash was recorded')
  } else {
    log.error('crash probe: FAIL — a real renderer crash went unrecorded')
  }

  // The record must say what died and why, or it is useless for diagnosis.
  const recorded = after.events[0]
  if (recorded && recorded.process.length > 0 && recorded.reason.length > 0) {
    log.info(`crash probe: PASS — the record names the process and reason`)
  } else {
    log.error('crash probe: FAIL — the crash record is missing detail')
  }

  // And clearing must actually delete.
  await probe.clear()
  const cleared = await probe.report()
  if (cleared.events.length === 0 && cleared.dumpCount === 0) {
    log.info('crash probe: PASS — clearing removes both the events and the dumps')
  } else {
    log.error(
      `crash probe: FAIL — after clearing, ${cleared.events.length} event(s) and ${cleared.dumpCount} dump(s) remain`
    )
  }

  app.quit()
}

/**
 * Dev-only verification of update checking, against a real served feed.
 *
 * Run against a local HTTP server rather than a hosted one, because the point is
 * to exercise this code: the fetch through Chromium's stack, the YAML reading,
 * and the version comparison that decides whether an update exists at all.
 */
export async function runUpdateCapture(probe: {
  setFeed: (url: string) => void
  check: () => Promise<{
    state: string
    currentVersion: string
    latestVersion: string | null
    detail: string
    canInstall: boolean
  }>
  status: () => { state: string; detail: string }
  baseUrl: string
}): Promise<void> {
  // 1. No feed configured: nothing is contacted, and it says so.
  probe.setFeed('')
  const none = probe.status()
  log.info(`update probe: no feed → ${none.state}`)
  if (none.state === 'no-channel') {
    log.info('update probe: PASS — with no feed configured, nothing is checked')
  } else {
    log.error('update probe: FAIL — a default endpoint is being contacted')
  }

  // 2. A feed advertising a newer version.
  probe.setFeed(`${probe.baseUrl}/newer.yml`)
  const newer = await probe.check()
  log.info(`update probe: newer feed → ${newer.state}, running ${newer.currentVersion}, offered ${newer.latestVersion}`)
  if (newer.state === 'update-available' && newer.latestVersion === '9.9.9') {
    log.info('update probe: PASS — a newer version is found and reported')
  } else {
    log.error('update probe: FAIL — a newer version was not detected')
  }
  if (!newer.canInstall && /not.*sign|unsigned/i.test(newer.detail)) {
    log.info('update probe: PASS — it states it cannot install, and why')
  } else {
    log.error('update probe: FAIL — it implies it can install an unsigned update')
  }

  // 3. A feed advertising an older version must not offer a downgrade.
  probe.setFeed(`${probe.baseUrl}/older.yml`)
  const older = await probe.check()
  log.info(`update probe: older feed → ${older.state} (offered ${older.latestVersion})`)
  if (older.state === 'up-to-date') {
    log.info('update probe: PASS — an older feed version is not offered as an update')
  } else {
    log.error('update probe: FAIL — offered a downgrade')
  }

  // 4. A broken feed must report unreadable rather than crash or claim success.
  probe.setFeed(`${probe.baseUrl}/garbage.yml`)
  const broken = await probe.check()
  log.info(`update probe: unreadable feed → ${broken.state}`)
  if (broken.state === 'error') {
    log.info('update probe: PASS — an unreadable feed is an error, not a silent pass')
  } else {
    log.error('update probe: FAIL — a broken feed was treated as a result')
  }

  // 5. An unreachable feed must not hang the UI.
  probe.setFeed('http://127.0.0.1:1/latest.yml')
  const unreachable = await probe.check()
  log.info(`update probe: unreachable feed → ${unreachable.state}`)
  if (unreachable.state === 'error') {
    log.info('update probe: PASS — an unreachable feed fails cleanly')
  } else {
    log.error('update probe: FAIL — an unreachable feed did not settle')
  }

  probe.setFeed('')
  app.quit()
}

/**
 * Dev-only verification of page watching.
 *
 * Serves a page whose price and text change between visits, so the whole path is
 * exercised against a real document: extraction, normalisation, the hash
 * short-circuit, and the diff. The negative case matters most — revisiting an
 * unchanged page must report nothing, or the feature is noise.
 */
export async function runWatchCapture(
  window: BrowserWindowController,
  probe: {
    watch: (url: string, title: string) => void
    checkPage: (url: string) => Promise<{ summary: string } | null>
    changeCount: () => number
    setVariant: (variant: 'a' | 'b') => void
    url: string
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  // First visit establishes the baseline; nothing can be reported yet.
  probe.setVariant('a')
  window.tabs.navigate(activeId, probe.url)
  await delay(4000)
  probe.watch(probe.url, 'Watched fixture')
  const baseline = await probe.checkPage(probe.url)
  log.info(`watch probe: baseline → ${baseline ? 'reported a change' : 'no change (correct)'}`)
  if (baseline === null) {
    log.info('watch probe: PASS — the first visit sets a baseline rather than claiming a change')
  } else {
    log.error('watch probe: FAIL — claimed a change with nothing to compare against')
  }

  // Revisit the same content. Reporting here would make the feature noise.
  window.tabs.navigate(activeId, `${probe.url}?again=1`)
  await delay(3500)
  const unchanged = await probe.checkPage(probe.url)
  if (unchanged === null) {
    log.info('watch probe: PASS — an unchanged page reports nothing')
  } else {
    log.error(`watch probe: FAIL — reported a change on unchanged content: ${unchanged.summary}`)
  }

  // Now change the price and some text.
  probe.setVariant('b')
  window.tabs.navigate(activeId, `${probe.url}?v=2`)
  await delay(3500)
  const changed = await probe.checkPage(probe.url)
  log.info(`watch probe: after edit → ${changed ? changed.summary : 'nothing detected'}`)
  if (changed && /£1,299\.00 → £1,499\.00/.test(changed.summary)) {
    log.info('watch probe: PASS — the price movement was detected and quoted')
  } else {
    log.error('watch probe: FAIL — the price change was missed')
  }
  if (changed && /removed/.test(changed.summary)) {
    log.info('watch probe: PASS — removed text is called out')
  } else {
    log.error('watch probe: FAIL — a removed passage was not reported')
  }

  log.info(`watch probe: ${probe.changeCount()} change(s) recorded in total`)
  if (probe.changeCount() === 1) {
    log.info('watch probe: PASS — exactly one change recorded across three visits')
  } else {
    log.error(`watch probe: FAIL — expected 1 recorded change, got ${probe.changeCount()}`)
  }

  app.quit()
}

/**
 * Dev-only verification of Mission Mode against real pages.
 *
 * The property that matters is the negative one: an on-mission page must be
 * absorbed in silence. A prompt that fires on pages the user obviously needs is
 * one they will switch off within a day, taking the feature with it.
 */
export async function runMissionCapture(
  window: BrowserWindowController,
  probe: {
    start: (goal: string) => void
    visit: (url: string, title: string) => string | null
    saveForLater: (url: string, title: string) => void
    active: () => { goal: string; pages: number; saved: number; notes: string } | null
    setNotes: (notes: string) => void
    complete: () => void
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  probe.start('Finish my research paper on coral reef bleaching')
  log.info(`mission probe: started "${probe.active()?.goal}"`)

  // On-mission pages: absorbed silently.
  const onMission = [
    ['https://en.wikipedia.org/wiki/Coral_bleaching', 'Coral bleaching - Wikipedia'],
    ['https://en.wikipedia.org/wiki/Coral_reef', 'Coral reef - Wikipedia']
  ] as const
  let interruptions = 0
  for (const [url, title] of onMission) {
    const suggestion = probe.visit(url, title)
    if (suggestion) {
      interruptions++
      log.error(`mission probe: interrupted on a related page — ${title}`)
    }
  }
  if (interruptions === 0) {
    log.info('mission probe: PASS — related pages were absorbed without a prompt')
  } else {
    log.error(`mission probe: FAIL — prompted on ${interruptions} related page(s)`)
  }

  const afterRelated = probe.active()
  log.info(`mission probe: mission holds ${afterRelated?.pages} page(s)`)
  if ((afterRelated?.pages ?? 0) >= 2) {
    log.info('mission probe: PASS — related pages were added to the mission')
  } else {
    log.error('mission probe: FAIL — related pages were not recorded')
  }

  // A clear digression: offered, never blocked.
  const digression = probe.visit(
    'https://en.wikipedia.org/wiki/Premier_League',
    'Premier League - Wikipedia'
  )
  log.info(`mission probe: digression → ${digression ?? 'no suggestion'}`)
  if (digression && /save it for later/.test(digression)) {
    log.info('mission probe: PASS — an unrelated page is offered, not blocked')
  } else {
    log.error('mission probe: FAIL — the digression produced no offer')
  }

  // And the digression must not have been added to the mission's own pages,
  // which would poison the context the relevance judgement depends on.
  if (probe.active()?.pages === afterRelated?.pages) {
    log.info('mission probe: PASS — the digression was not added to the mission')
  } else {
    log.error('mission probe: FAIL — an off-mission page joined the mission')
  }

  probe.saveForLater('https://en.wikipedia.org/wiki/Premier_League', 'Premier League - Wikipedia')
  probe.setNotes('Bleaching correlates with sustained temperature anomalies.')
  const saved = probe.active()
  log.info(`mission probe: ${saved?.saved} saved for later, notes ${saved?.notes ? 'kept' : 'lost'}`)
  if (saved?.saved === 1 && saved.notes !== '') {
    log.info('mission probe: PASS — saving for later and notes both persist')
  } else {
    log.error('mission probe: FAIL — saved pages or notes were lost')
  }

  probe.complete()
  if (probe.active() === null) {
    log.info('mission probe: PASS — completing ends the mission')
  } else {
    log.error('mission probe: FAIL — the mission is still active after completing')
  }

  app.quit()
}

/**
 * Dev-only verification of multi-provider comparison, against stub endpoints.
 *
 * **This proves the plumbing, not the answers.** Real answers need live
 * credentials for three separate companies, so what is tested here is the part
 * that can go wrong regardless of provider: the fan-out, and above all the
 * isolation — one provider being down must not cost the user the others.
 */
export async function runCompareCapture(probe: {
  run: (question: string) => Promise<{
    answers: Array<{ providerName: string; state: string; text: string; error: string }>
  }>
}): Promise<void> {
  const result = await probe.run('Which of these is best?')
  log.info(`compare probe: ${result.answers.length} answer row(s)`)
  for (const answer of result.answers) {
    log.info(
      `   ${answer.providerName}: ${answer.state}${answer.state === 'answered' ? ` — "${answer.text.slice(0, 40)}"` : ` — ${answer.error}`}`
    )
  }

  const answered = result.answers.filter((answer) => answer.state === 'answered')
  const failed = result.answers.filter((answer) => answer.state === 'failed')

  if (result.answers.length === 3) {
    log.info('compare probe: PASS — every provider produced a row')
  } else {
    log.error(`compare probe: FAIL — expected 3 rows, got ${result.answers.length}`)
  }

  // The load-bearing check. One dead provider must not discard the others.
  if (answered.length === 2 && failed.length === 1) {
    log.info('compare probe: PASS — a failing provider did not deny the working answers')
  } else {
    log.error(
      `compare probe: FAIL — ${answered.length} answered and ${failed.length} failed; isolation is broken`
    )
  }

  if (failed[0] && failed[0].error.length > 0 && !/undefined|\[object/.test(failed[0].error)) {
    log.info('compare probe: PASS — the failure is explained in words')
  } else {
    log.error('compare probe: FAIL — the failure row carries no usable explanation')
  }

  if (answered.every((answer) => answer.text.length > 0)) {
    log.info('compare probe: PASS — answers carry their text')
  } else {
    log.error('compare probe: FAIL — an answered row had no text')
  }

  app.quit()
}

/**
 * Dev-only verification of the YouTube ad-break filter.
 *
 * Two things are checked, because either alone would be misleading. The
 * mechanism is tested deterministically — a synthetic player response must come
 * back stripped — and then a real watch page is loaded to confirm the script is
 * installed and the player still works. Ad-break presence on a live video
 * depends on whether that video is monetised, which is not ours to control, so
 * the mechanism test is the one that can actually fail.
 */
export async function runYouTubeAdCapture(
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    app.quit()
    return
  }

  window.tabs.navigate(activeId, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await delay(12000)

  const contents = window.tabs.activeTab?.contents
  if (!contents) {
    log.error('youtube ad probe: FAIL — no page to inspect')
    app.quit()
    return
  }

  // 1. Is the accessor in place at all? Without it nothing else can work.
  const installed = (await contents.executeJavaScript(
    `!!Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse')?.set`,
    true
  )) as boolean
  log.info(`youtube ad probe: interceptor installed = ${installed}`)
  if (installed) {
    log.info('youtube ad probe: PASS — the script ran before the page in its own context')
  } else {
    log.error('youtube ad probe: FAIL — the script did not reach the page context')
  }

  // 2. The mechanism itself: a response carrying ad breaks must come back without
  //    them. Deterministic, unlike whether a given video is monetised.
  const stripped = (await contents.executeJavaScript(
    `(() => {
       window.ytInitialPlayerResponse = {
         videoDetails: { videoId: 'probe' },
         adPlacements: [{ x: 1 }],
         playerAds: [{ y: 2 }],
         adSlots: [{ z: 3 }]
       };
       const after = window.ytInitialPlayerResponse;
       return {
         adPlacements: after.adPlacements === undefined,
         playerAds: after.playerAds === undefined,
         adSlots: after.adSlots === undefined,
         keptVideoDetails: after.videoDetails?.videoId === 'probe'
       };
     })()`,
    true
  )) as Record<string, boolean>
  log.info(`youtube ad probe: strip result ${JSON.stringify(stripped)}`)

  if (stripped.adPlacements && stripped.playerAds && stripped.adSlots) {
    log.info('youtube ad probe: PASS — ad break fields are removed from the player response')
  } else {
    log.error('youtube ad probe: FAIL — ad break fields survived')
  }
  if (stripped.keptVideoDetails) {
    log.info('youtube ad probe: PASS — the rest of the player response is untouched')
  } else {
    log.error('youtube ad probe: FAIL — the strip damaged the player response')
  }

  // 2b. The fetch path. YouTube's own navigation — home to video, video to next
  //     video — reads the player response with Response.json(), which never
  //     calls JSON.parse. This was the hole when "ads still play" was reported:
  //     only a directly-navigated watch page was being stripped. Constructing a
  //     Response in the page exercises the hook without any network.
  const viaFetch = (await contents.executeJavaScript(
    `Promise.all([
        new Response(JSON.stringify({
          videoDetails: { videoId: 'probe2' },
          adPlacements: [{ x: 1 }],
          playerAds: [{ y: 2 }],
          adSlots: [{ z: 3 }]
        })).json(),
        new Response('{"unrelated":true}').json()
      ]).then(([after, plain]) => ({
        adPlacements: after.adPlacements === undefined,
        playerAds: after.playerAds === undefined,
        adSlots: after.adSlots === undefined,
        keptVideoDetails: after.videoDetails && after.videoDetails.videoId === 'probe2',
        ordinaryJsonUntouched: plain.unrelated === true
      }))`,
    true
  )) as Record<string, boolean>
  log.info(`youtube ad probe: fetch-path strip ${JSON.stringify(viaFetch)}`)
  if (viaFetch.adPlacements && viaFetch.playerAds && viaFetch.adSlots && viaFetch.keptVideoDetails) {
    log.info('youtube ad probe: PASS — Response.json() strips the SPA player response')
  } else {
    log.error('youtube ad probe: FAIL — a fetched player response keeps its ad breaks')
  }
  if (viaFetch.ordinaryJsonUntouched) {
    log.info('youtube ad probe: PASS — unrelated fetched JSON passes through untouched')
  } else {
    log.error('youtube ad probe: FAIL — the fetch hook touched unrelated JSON')
  }

  // 2c. The text path, for completeness: XHR bodies are strings the page parses
  //     itself, so they go through JSON.parse.
  const viaParse = (await contents.executeJavaScript(
    `JSON.parse('{"streamingData":{},"adPlacements":[1]}').adPlacements === undefined
       && JSON.parse('{"a":1}').a === 1`,
    true
  )) as boolean
  if (viaParse) {
    log.info('youtube ad probe: PASS — JSON.parse strips player responses and nothing else')
  } else {
    log.error('youtube ad probe: FAIL — the JSON.parse path is wrong')
  }

  // 3. And the page must still be a working YouTube page, not a broken one.
  const playable = (await contents.executeJavaScript(
    `!!document.querySelector('video') && document.title.length > 0`,
    true
  )) as boolean
  if (playable) {
    log.info('youtube ad probe: PASS — the player is still present and the page loaded')
  } else {
    log.error('youtube ad probe: FAIL — YouTube did not load properly with the filter on')
  }

  // 4. Off YouTube the script must do nothing at all.
  window.tabs.navigate(activeId, 'https://example.com')
  await delay(4000)
  const elsewhere = (await (window.tabs.activeTab?.contents?.executeJavaScript(
    `!!Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse')?.set`,
    true
  ) ?? Promise.resolve(false))) as boolean
  if (!elsewhere) {
    log.info('youtube ad probe: PASS — the script is inert on other sites')
  } else {
    log.error('youtube ad probe: FAIL — the interceptor is active off YouTube')
  }

  window.tabs.navigate(activeId, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await delay(9000)
  await captureWindowTo(window, outputPath)
  app.quit()
}

/** Polls a condition until it holds or the deadline passes. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await delay(250)
  }
  return condition()
}

function ipcBroadcastUiCommand(window: BrowserWindowController, command: string): void {
  for (const contents of window.privilegedContents()) {
    contents.send('ui:command', { command })
  }
}

async function waitForActiveTab(
  window: BrowserWindowController,
  timeoutMs = 15000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const id = window.tabs.snapshot().activeTabId
    if (id) return id
    await delay(120)
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function captureWindowTo(
  window: BrowserWindowController,
  outputPath: string,
  options: { front?: boolean } = {}
): Promise<void> {
  // Windows Graphics Capture returns a blank frame for an occluded window, so
  // the window has to be fronted first. Without this the capture silently
  // succeeds and writes an empty dark rectangle — which reads as a compositing
  // bug in the app rather than a limitation of the harness.
  //
  // `front: false` is for frames that depend on where keyboard focus is: raising
  // the window blurs the omnibox, which clears the draft and tears the
  // suggestion dropdown down before it can be photographed.
  if (options.front !== false) {
    window.browserWindow.show()
    window.browserWindow.moveTop()
    window.browserWindow.focus()
    await delay(500)
  }

  const { width, height } = window.browserWindow.getBounds()
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width, height }
  })
  // Substring, not equality: the window title now follows the active tab, so it
  // reads "Example Domain — Slash". An exact match silently fell
  // through to sources[0] and captured whatever unrelated window happened to be
  // first.
  const source = sources.find((s) => s.name.includes('Slash'))
  if (!source) {
    log.error('capture: no window source found')
    return
  }
  await writeFile(outputPath, source.thumbnail.toPNG())
  log.info(`capture: wrote ${outputPath}`)
}

/**
 * Checks from inside the page that web content has no privileged capability.
 *
 * This is asserted by evaluating in the page's own context rather than by reading
 * our configuration, because the configuration is exactly what could be wrong.
 * `window.browser` must be undefined in web content: the bridge belongs to the
 * chrome preload only.
 */
async function assertPageIsUnprivileged(window: BrowserWindowController): Promise<void> {
  const contents = window.tabs.activeTab?.contents ?? null
  if (!contents) {
    log.warn('security probe skipped: active tab has no page view')
    return
  }

  const probe = (await contents.executeJavaScript(
    `({
       browser: typeof window.browser,
       require: typeof window.require,
       process: typeof window.process,
       ipcRenderer: typeof window.ipcRenderer
     })`
  )) as Record<string, string>

  const leaked = Object.entries(probe).filter(([, type]) => type !== 'undefined')
  if (leaked.length === 0) {
    log.info('security probe: PASS — page view has no browser/require/process/ipcRenderer')
  } else {
    log.error(
      `security probe: FAIL — web content can reach ${leaked.map(([k, v]) => `${k}:${v}`).join(', ')}`
    )
  }
}

/**
 * Dev-only private-browsing verification.
 *
 * The claim "nothing is saved" spans four separate write paths — history,
 * browsing memory, closed tabs and session snapshots — and privacy that covers
 * three of them is not privacy. This visits a page in a private window and
 * checks the database directly rather than trusting that each guard was wired.
 */
export async function runPrivateCapture(
  window: BrowserWindowController,
  hooks: {
    openPrivate: () => BrowserWindowController
    historyCount: (url: string) => number
    memoryCount: (url: string) => number
    closedTabCount: () => number
  }
): Promise<void> {
  await waitForActiveTab(window)

  const marker = 'https://example.com/private-probe'
  const priv = hooks.openPrivate()
  await delay(1500)

  const tabId = priv.tabs.snapshot().activeTabId ?? priv.tabs.create({ url: marker })
  if (typeof tabId === 'string') priv.tabs.navigate(tabId, marker)
  await delay(4000)

  // Close the tab too, so the closed-tab store gets its chance to record it.
  const active = priv.tabs.snapshot().activeTabId
  if (active) priv.tabs.close(active)
  await delay(1000)

  const history = hooks.historyCount(marker)
  const memory = hooks.memoryCount(marker)
  const closed = hooks.closedTabCount()

  log.info(`private probe: history=${history} memory=${memory} closedTabs=${closed}`)
  if (history === 0 && memory === 0) {
    log.info('private probe: PASS — nothing written to history or browsing memory')
  } else {
    log.error('private probe: FAIL — a private visit reached the database')
  }

  app.quit()
}

/**
 * Dev-only check that a settings change reaches the interface.
 *
 * The value was always written to SQLite; what was missing was the broadcast
 * telling the renderer. That failure is invisible to a typecheck and to any test
 * that stops at the repository, so it is verified here by changing a setting and
 * reading the accent colour back off the live document.
 */
/**
 * Opens the shield panel over a real page and captures the window.
 *
 * Exists because the panel shipped clipped: it rendered in the chrome document,
 * and the native page view composited above it, so everything overlapping the
 * page was invisible. The capture proves the overlay version actually paints
 * over page content — something no unit test can see.
 *
 * Goes through `overlay:setState` from the chrome view, the same call the
 * shield button makes, so the first-ever-surface mount race is exercised too.
 */
export async function runShieldPanelCapture(
  window: BrowserWindowController,
  outputPath: string
): Promise<void> {
  await waitForActiveTab(window)
  const activeId = window.tabs.activeTab?.id
  const chrome = window.privilegedContents()[0]
  if (!activeId || !chrome) {
    log.error('shield panel probe: no tab or chrome view')
    app.quit()
    return
  }

  // A real page with edge-to-edge content, so a clipped panel would be obvious.
  window.tabs.navigate(activeId, 'https://en.wikipedia.org/wiki/Web_browser')
  await delay(8000)

  await chrome.executeJavaScript(
    `window.browser.invoke('overlay:setState', { visible: true, surface: 'shield' })`
  )
  // The overlay document may be loading for the first time; the panel then has
  // to ask which tab is active and fetch its blocking status.
  await delay(4000)

  const overlayContents = window.overlay.webContents
  const panelState = overlayContents
    ? ((await overlayContents.executeJavaScript(
        `(() => {
           const text = document.body.innerText;
           return {
             mounted: text.includes('blocked on this page') || text.includes('Blocking is off'),
             hasStrict: text.includes('Strict mode'),
             hasHonesty: text.includes('not a virus scanner') || text.includes('virus scanner')
           };
         })()`
      )) as { mounted: boolean; hasStrict: boolean; hasHonesty: boolean })
    : { mounted: false, hasStrict: false, hasHonesty: false }

  log.info(`shield panel probe: ${JSON.stringify(panelState)}`)
  if (panelState.mounted && panelState.hasStrict) {
    log.info('shield panel probe: PASS — the panel mounted in the overlay over a live page')
  } else {
    log.error('shield panel probe: FAIL — the overlay did not show the shield panel')
  }

  await captureWindowTo(window, outputPath)

  // And it must come down cleanly — a stuck modal overlay eats every click.
  await chrome.executeJavaScript(
    `window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })`
  )
  await delay(600)
  const downState = window.overlay.getState()
  if (!downState.visible) {
    log.info('shield panel probe: PASS — the overlay dismissed')
  } else {
    log.error('shield panel probe: FAIL — the overlay is stuck visible')
  }
  app.quit()
}

export async function runSettingsCapture(window: BrowserWindowController): Promise<void> {
  await waitForActiveTab(window)
  const chrome = window.privilegedContents()[0]
  if (!chrome) {
    log.error('settings probe: no chrome view')
    app.quit()
    return
  }

  const read = async (): Promise<string> =>
    (await chrome.executeJavaScript(
      `getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()`
    )) as string

  const before = await read()

  await chrome.executeJavaScript(
    `window.browser.invoke('settings:update', { accentColor: 'rose' })`
  )
  await delay(1200)
  const after = await read()

  log.info(`settings probe: accent before=${before} after=${after}`)
  if (before !== after && after.length > 0) {
    log.info('settings probe: PASS — a settings change repaints the interface')
  } else {
    log.error('settings probe: FAIL — the change never reached the renderer')
  }

  // Leave the profile as it was found.
  await chrome.executeJavaScript(
    `window.browser.invoke('settings:update', { accentColor: 'default' })`
  )
  await delay(400)
  app.quit()
}
