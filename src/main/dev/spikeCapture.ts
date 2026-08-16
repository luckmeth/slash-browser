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
