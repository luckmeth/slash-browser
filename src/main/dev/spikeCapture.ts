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

  const source = sources.find((s) => s.name === 'Adaptive Browser') ?? sources[0]
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
    ctx.workspaces.create({ name: 'Work', icon: '💼', color: 'green', isolated: true })
    ctx.workspaces.create({ name: 'Research', icon: '🔬', color: 'purple', isolated: false })
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

  app.quit()
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
  outputPath: string
): Promise<void> {
  const { width, height } = window.browserWindow.getBounds()
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width, height }
  })
  const source = sources.find((s) => s.name === 'Adaptive Browser') ?? sources[0]
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
