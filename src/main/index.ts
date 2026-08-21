import type { ServerResponse } from 'node:http'
import { app, BrowserWindow } from 'electron'
import { AppContext } from './AppContext'
import { parseQuery as parseQueryForDev } from './memory/parseQuery'
import { buildApplicationMenu } from './menu'
import { createLogger } from './logger'
import { prepareUserDataPath } from './userData'
import { CrashReporting } from './diagnostics/CrashReporting'

const log = createLogger('main')

// Before anything reads a path, and before the single-instance lock, which is
// itself keyed off the user-data location.
prepareUserDataPath()

// Before any renderer exists. Chromium writes a minidump when one dies, but
// discards it unless the reporter is running — and the most interesting crash is
// often the one during startup, which a later call would miss.
CrashReporting.start()

// A browser is a single-instance application: a second launch must hand its
// arguments to the running copy rather than open a rival process that would
// contend for the same SQLite file and session partitions.
if (!app.requestSingleInstanceLock()) {
  log.info('another instance holds the lock; exiting')
  app.quit()
} else {
  const context = new AppContext()

  /**
   * Which window a launch is asking for.
   *
   * The taskbar jump list relaunches the executable with a flag rather than
   * talking to the running copy, so the single-instance path has to read the
   * *second* instance's argv — not this process's — and act on it.
   */
  const windowRequest = (argv: readonly string[]): 'private' | 'normal' | null => {
    if (argv.includes('--new-private-window')) return 'private'
    if (argv.includes('--new-window')) return 'normal'
    return null
  }

  app.on('second-instance', (_event, argv) => {
    const requested = windowRequest(argv)
    if (requested) {
      context.createWindow({ isPrivate: requested === 'private' })
      return
    }

    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(() => {
    context.start()
    buildApplicationMenu(context)

    // Right-clicking the taskbar icon. Every mainstream browser offers these
    // and Slash offered nothing at all, which is one of the two reasons private
    // browsing looked as though it had never been built.
    //
    // Windows-only: `setUserTasks` is a no-op elsewhere, so no platform guard is
    // needed beyond what Electron already does.
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: '--new-window',
        title: 'New window',
        description: 'Open a new Slash window',
        iconPath: process.execPath,
        iconIndex: 0
      },
      {
        program: process.execPath,
        arguments: '--new-private-window',
        title: 'New private window',
        description: 'Open a window that records nothing',
        iconPath: process.execPath,
        iconIndex: 0
      }
    ])

    // A first launch can itself carry the flag — clicking the jump list while
    // Slash is closed starts it fresh rather than reaching a running copy.
    const launchRequest = windowRequest(process.argv)
    const window = context.createWindow({ isPrivate: launchRequest === 'private' })

    // Bring back what was open when the browser was last closed.
    //
    // Restored tabs are created without renderers and materialise on activation,
    // so reopening forty tabs does not launch forty processes at once. What this
    // genuinely restores is pages, order, pinning, scroll and back/forward
    // history — not logged-in state beyond what the cookies already carry.
    // Groups before tabs: restored tabs carry a group id, and the check that
    // drops ids naming groups which no longer exist needs the groups loaded to
    // know which those are.
    window.tabs.loadGroups(context.tabGroups.list())

    if (context.settings.getAll().restoreTabsOnStartup) {
      const previous = context.snapshots.latestRestorable()
      if (previous && previous.tabs.length > 0) {
        const restored = window.tabs.restoreFromSnapshot(previous.tabs, { activateFirst: true })
        log.info(
          `startup: restored ${restored} tab(s) from the previous session ` +
            `(${previous.kind === 'automatic' ? 'autosave — the browser did not exit cleanly' : 'clean exit'})`
        )
      }
    }

    // First run. After the session restore above, so the walkthrough opens over
    // whatever the user is actually going to see rather than a blank window.
    // Deferred a beat so the chrome has painted first — a modal appearing before
    // the thing it is introducing reads as a launch error.
    if (!context.settings.getAll().onboardingCompleted) {
      setTimeout(() => {
        if (!window.browserWindow.isDestroyed()) window.showOnboarding()
      }, 900)
    }

    const spikePath = process.env['ADAPTIVE_SPIKE_CAPTURE']
    if (spikePath) {
      void import('./dev/spikeCapture').then(({ runSpikeCapture }) =>
        runSpikeCapture(window, spikePath)
      )
    }

    const handoffPath = process.env['SLASH_HANDOFF_CAPTURE']
    if (handoffPath) {
      void import('./dev/spikeCapture').then(({ runHandoffCapture }) =>
        runHandoffCapture(window, handoffPath)
      )
    }

    const googlePath = process.env['SLASH_GOOGLE_DIAGNOSTIC']
    if (googlePath) {
      void import('./dev/spikeCapture').then(({ runGoogleDiagnostic }) =>
        runGoogleDiagnostic(window, googlePath)
      )
    }

    if (process.env['SLASH_YOUTUBE_PROBE']) {
      const seen: { url: string; blocked: boolean }[] = []
      context.blocker.onDecision = (url, blocked) => seen.push({ url, blocked })
      void import('./dev/spikeCapture').then(({ runYouTubeCapture }) =>
        runYouTubeCapture(window, {
          onRequest: () => {},
          report: () => {
            // Group by the shape that matters: which path prefixes carry ads,
            // and whether anything stopped them.
            const interesting = seen.filter((s) =>
              /pagead|doubleclick|\/ads|adformat|ptracking|googlevideo|get_video_info|player\?|youtubei\/v1\/player/i.test(
                s.url
              )
            )
            const lines = interesting
              .slice(0, 40)
              .map((s) => `${s.blocked ? 'BLOCKED' : 'allowed'} ${s.url.slice(0, 130)}`)
            return `${seen.length} requests, ${seen.filter((s) => s.blocked).length} blocked\n${lines.join('\n')}`
          }
        })
      )
    }

    if (process.env['SLASH_SETTINGS_PROBE']) {
      void import('./dev/spikeCapture').then(({ runSettingsCapture }) =>
        runSettingsCapture(window)
      )
    }

    if (process.env['SLASH_PRIVATE_PROBE']) {
      void import('./dev/spikeCapture').then(({ runPrivateCapture }) =>
        runPrivateCapture(window, {
          openPrivate: () => context.createWindow({ isPrivate: true }),
          historyCount: (url) => context.history.search(url, 50, 0).length,
          memoryCount: (url) =>
            context.memoryRepository.search(parseQueryForDev(url), 50).length,
          closedTabCount: () => context.closedTabs.list().length
        })
      )
    }

    if (process.env['SLASH_REDIRECT_PROBE']) {
      void import('./dev/spikeCapture').then(({ runRedirectCapture }) =>
        runRedirectCapture(window, { lockTab: (tabId) => context.siteLockedTabs.add(tabId) })
      )
    }

    if (process.env['SLASH_POPUP_PROBE']) {
      void import('./dev/spikeCapture').then(({ runPopupCapture }) =>
        runPopupCapture(window, { tabCount: () => window.tabs.allTabs().length })
      )
    }

    if (process.env['SLASH_UNSAVED_PROBE']) {
      void import('./dev/spikeCapture').then(({ runUnsavedInputCapture }) =>
        runUnsavedInputCapture(window)
      )
    }

    const blockPath = process.env['ADAPTIVE_BLOCK_CAPTURE']
    if (blockPath) {
      void import('./dev/spikeCapture').then(({ runBlockingCapture }) =>
        runBlockingCapture(window, blockPath, {
          countFor: (id) => context.blocker.countFor(id),
          diagnostics: context.blocker.diagnostics
        })
      )
    }

    const memoryPath = process.env['ADAPTIVE_MEMORY_CAPTURE']
    if (memoryPath) {
      void import('./dev/spikeCapture').then(({ runMemoryCapture }) =>
        runMemoryCapture(window, memoryPath, {
          setIndexing: (history, content) =>
            context.settings.update({ indexHistory: history, indexPageContent: content }),
          excludeOrigin: (origin) =>
            context.settings.update({
              excludedOrigins: [...context.settings.getAll().excludedOrigins, origin]
            }),
          search: (query) => ({
            results: context.memoryRepository.search(parseQueryForDev(query), 10)
          }),
          stats: () => context.memoryRepository.stats(false, false),
          clear: () => {
            context.memoryRepository.clearAll()
            context.settings.update({ excludedOrigins: [] })
          }
        })
      )
    }

    if (process.env['SLASH_ONBOARDING_PROBE']) {
      void import('./dev/spikeCapture').then(({ runOnboardingCapture }) =>
        runOnboardingCapture(window, {
          settings: () => context.settings.getAll() as unknown as Record<string, unknown>,
          update: (patch) => context.settings.update(patch)
        })
      )
    }

    if (process.env['SLASH_TABGROUP_PROBE']) {
      void import('./dev/spikeCapture').then(({ runTabGroupCapture }) =>
        runTabGroupCapture(window, { persisted: () => context.tabGroups.list().length })
      )
    }

    if (process.env['SLASH_READING_PROBE']) {
      void import('./dev/spikeCapture').then(({ runReadingListCapture }) =>
        runReadingListCapture({
          schemaVersion: () => context.db.status().schemaVersion,
          list: () => context.readingList.list(),
          add: (item) => context.readingList.add(item),
          setRead: (id, read) => context.readingList.setRead(id, read),
          clearRead: () => context.readingList.clearRead(),
          remove: (id) => context.readingList.remove(id)
        })
      )
    }

    if (process.env['SLASH_VAULT_PROBE']) {
      void import('./dev/spikeCapture').then(({ runVaultCapture }) =>
        runVaultCapture(window, {
          available: () => context.vault.available,
          save: (input) => context.vault.save(input),
          status: () => context.vault.status(),
          passwordFor: (id) => context.vault.passwordFor(id),
          list: () => context.vault.list(),
          remove: (id) => context.vault.remove(id),
          dbPath: () => context.db.status().path,
          fill: async (tabId, loginId) => {
            const contents = window.tabs.findById(tabId)?.contents
            if (!contents) return 'no tab'
            const form = context.loginForms.get(contents.id) ?? {
              hasPasswordField: false,
              hasUsernameField: false
            }
            return context.loginFiller.fill(contents, loginId, form)
          }
        })
      )
    }

    if (process.env['SLASH_ZOOM_PROBE']) {
      void import('./dev/spikeCapture').then(({ runZoomCapture }) =>
        runZoomCapture(window, { siteZoom: () => context.settings.getAll().siteZoom })
      )
    }

    if (process.env['SLASH_ADBLOCK_PROBE']) {
      void import('./dev/spikeCapture').then(({ runAdblockCapture }) =>
        runAdblockCapture(window, {
          ready: () => context.blocker.adblock.ready,
          matches: (url, source, type) => context.blocker.adblock.matches(url, source, type),
          cosmetics: (url, hostname, domain) =>
            context.blocker.adblock.cosmeticStylesFor(url, hostname, domain)
        })
      )
    }

    if (process.env['SLASH_SPONSOR_PROBE']) {
      void import('./dev/spikeCapture').then(({ runSponsorCapture }) =>
        runSponsorCapture({
          setEndpoint: (url) =>
            context.settings.update({ sponsorEndpoint: url, sponsoredTilesEnabled: true }),
          refresh: () => context.sponsor.refresh(),
          status: () => context.sponsor.status(),
          impression: (id) => context.sponsor.recordImpression(id),
          click: (id) => context.sponsor.recordClick(id),
          tileFor: (id) => context.sponsor.tileFor(id),
          clear: () => {
            context.sponsor.clear()
            context.settings.update({ sponsorEndpoint: '', sponsoredTilesEnabled: false })
          }
        })
      )
    }

    if (process.env['SLASH_PALETTE_PROBE']) {
      void import('./dev/spikeCapture').then(({ runPaletteCapture }) => runPaletteCapture(window))
    }

    if (process.env['SLASH_POLISH_PROBE']) {
      void Promise.all([import('./dev/spikeCapture'), import('electron')]).then(
        ([{ runPolishCapture }, { Menu }]) =>
          runPolishCapture(window, {
            menuAccelerators: () => {
              const menu = Menu.getApplicationMenu()
              if (!menu) return 0
              let count = 0
              for (const top of menu.items) {
                for (const item of top.submenu?.items ?? []) {
                  if (item.accelerator && item.visible !== false) count += 1
                }
              }
              return count
            }
          })
      )
    }

    if (process.env['SLASH_FULLSCREEN_PROBE']) {
      void import('./dev/spikeCapture').then(({ runFullscreenCapture }) =>
        runFullscreenCapture(window)
      )
    }

    if (process.env['SLASH_EXTENSION_PROBE']) {
      void import('./dev/spikeCapture').then(({ runExtensionCapture }) =>
        runExtensionCapture({
          add: (path) => context.extensions.add(path),
          status: () => context.extensions.getStatus(),
          remove: (id) => context.extensions.remove(id),
          ids: () => context.extensions.getStatus().extensions.map((e) => e.id)
        })
      )
    }

    const splitPath = process.env['SLASH_SPLIT_CAPTURE']
    if (splitPath) {
      void import('./dev/spikeCapture').then(({ runSplitCapture }) =>
        runSplitCapture(window, splitPath)
      )
    }

    const shieldPanelPath = process.env['SLASH_SHIELD_PANEL_CAPTURE']
    if (shieldPanelPath) {
      void import('./dev/spikeCapture').then(({ runShieldPanelCapture }) =>
        runShieldPanelCapture(window, shieldPanelPath)
      )
    }

    const youtubeAdPath = process.env['SLASH_YOUTUBE_AD_CAPTURE']
    if (youtubeAdPath) {
      void import('./dev/spikeCapture').then(({ runYouTubeAdCapture }) =>
        runYouTubeAdCapture(window, youtubeAdPath)
      )
    }

    if (process.env['SLASH_COMPARE_PROBE']) {
      void Promise.all([
        import('./dev/spikeCapture'),
        import('./ai/AiComparison'),
        import('./ai/LLMProvider'),
        import('node:http')
      ]).then(async ([{ runCompareCapture }, { AiComparisonService }, providers, http]) => {
        // Two OpenAI-compatible stubs: one answers, one refuses. Real answers
        // would need live credentials for three companies; what is provable here
        // is the fan-out and the isolation.
        const serve = (handler: (res: ServerResponse) => void) =>
          new Promise<string>((resolve) => {
            const server = http.createServer((_req, res) => handler(res))
            server.listen(0, '127.0.0.1', () => {
              const address = server.address()
              resolve(
                `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`
              )
            })
          })

        const okUrl = await serve((res) => {
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({ choices: [{ message: { content: 'The second one, for the RAM.' } }] })
          )
        })
        const slowUrl = await serve((res) => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ choices: [{ message: { content: 'It depends on budget.' } }] }))
        })
        const failUrl = await serve((res) => {
          res.statusCode = 429
          res.end('rate limited')
        })

        const service = new AiComparisonService()
        const targets = [
          { id: 'local' as const, name: 'Stub A', local: true,
            provider: new providers.OpenAICompatibleProvider(okUrl, '', 'stub-a') },
          { id: 'openai' as const, name: 'Stub B', local: false,
            provider: new providers.OpenAICompatibleProvider(slowUrl, '', 'stub-b') },
          { id: 'google' as const, name: 'Stub C (down)', local: false,
            provider: new providers.OpenAICompatibleProvider(failUrl, '', 'stub-c') }
        ]

        return runCompareCapture({
          run: (question) => service.run(question, targets)
        })
      })
    }

    if (process.env['SLASH_MISSION_PROBE']) {
      void import('./dev/spikeCapture').then(({ runMissionCapture }) =>
        runMissionCapture(window, {
          start: (goal) => {
            context.missions.start(goal)
          },
          visit: (url, title) => context.missions.notePageVisited(url, title),
          saveForLater: (url, title) => {
            const mission = context.missions.active()
            if (mission) context.missions.addItem(mission.id, url, title, 'saved')
          },
          active: () => {
            const mission = context.missions.active()
            return mission
              ? {
                  goal: mission.goal,
                  pages: mission.pages.length,
                  saved: mission.saved.length,
                  notes: mission.notes
                }
              : null
          },
          setNotes: (notes) => {
            const mission = context.missions.active()
            if (mission) context.missions.setNotes(mission.id, notes)
          },
          complete: () => context.missions.complete()
        })
      )
    }

    if (process.env['SLASH_WATCH_PROBE']) {
      void import('./dev/spikeCapture').then(async ({ runWatchCapture }) => {
        const { createServer } = await import('node:http')
        let variant: 'a' | 'b' = 'a'
        const server = createServer((_request, response) => {
          const price = variant === 'a' ? '1,299.00' : '1,499.00'
          const body = [
            '<html><body><main>',
            '<h1>Laptop X1</h1>',
            `<p>The price today is £${price} including delivery.</p>`,
            variant === 'a'
              ? '<p>Returns are accepted within thirty days of purchase.</p>'
              : '<p>All sales are final and no returns are accepted at all.</p>',
            '<p>This paragraph never changes between the two variants at all.</p>',
            '</main></body></html>'
          ].join('')
          response.setHeader('content-type', 'text/html')
          response.end(body)
        })
        const url = await new Promise<string>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`)
          })
        })
        return runWatchCapture(window, {
          url,
          setVariant: (next) => {
            variant = next
          },
          watch: (target, title) => context.watch.watch(target, title),
          checkPage: (target) =>
            context.watch.checkPage(window.tabs.activeTab?.contents ?? null, target),
          changeCount: () =>
            context.watch.list().reduce((total, page) => total + page.changes.length, 0)
        })
      })
    }

    if (process.env['SLASH_UPDATE_PROBE']) {
      void import('./dev/spikeCapture').then(async ({ runUpdateCapture }) => {
        const { createServer } = await import('node:http')
        // Built with join rather than escapes: a YAML body inside a nested
        // string literal is an escaping hazard, as this line already proved once.
        const newline = String.fromCharCode(10)
        const feed = (version: string, extra: string[] = []): string =>
          [`version: ${version}`, `path: Slash-${version}-x64.exe`, ...extra, ''].join(newline)
        const feeds: Record<string, string> = {
          '/newer.yml': feed('9.9.9'),
          '/older.yml': feed('0.0.1'),
          // No version key at all, so the feed is unreadable by design.
          '/garbage.yml': ['path: Slash.exe', 'sha512: abc==', ''].join(newline)
        }
        const server = createServer((request, response) => {
          const body = feeds[request.url ?? '']
          response.statusCode = body ? 200 : 404
          response.end(body ?? 'not found')
        })
        const baseUrl = await new Promise<string>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
          })
        })
        return runUpdateCapture({
          baseUrl,
          setFeed: (url) => context.settings.update({ updateFeedUrl: url }),
          check: () => context.updates.check(),
          status: () => context.updates.current()
        })
      })
    }

    if (process.env['SLASH_CRASH_PROBE']) {
      void import('./dev/spikeCapture').then(({ runCrashCapture }) =>
        runCrashCapture(window, {
          report: () => context.crashes.report(),
          clear: () => context.crashes.clear()
        })
      )
    }

    if (process.env['SLASH_AIHUB_PROBE']) {
      void import('./dev/spikeCapture').then(({ runAiHubCapture }) =>
        runAiHubCapture({
          status: () => context.providers.status(),
          connect: (input) =>
            context.providers.connect(input as Parameters<typeof context.providers.connect>[0]),
          disconnect: (provider) =>
            context.providers.disconnect(provider as Parameters<typeof context.providers.disconnect>[0]),
          setDefault: (provider) =>
            context.providers.setDefault(provider as Parameters<typeof context.providers.setDefault>[0]),
          canBuild: (provider) =>
            context.providers.build(provider as Parameters<typeof context.providers.build>[0]) !== null,
          // Reads the ciphertext straight off disk, to prove it is not the key.
          rawStoredBytes: (provider) => {
            const row = context.db.connection
              .prepare('SELECT api_key FROM ai_credentials WHERE provider = ?')
              .get(provider) as { api_key: Buffer | null } | undefined
            return row?.api_key ? row.api_key.toString('latin1') : null
          }
        })
      )
    }

    const chainPath = process.env['SLASH_REDIRECT_CHAIN_CAPTURE']
    if (chainPath) {
      void import('./dev/spikeCapture').then(({ runRedirectChainCapture }) =>
        runRedirectChainCapture(window, chainPath, {
          chains: () => window.redirectRecorder.list()
        })
      )
    }

    const insightPath = process.env['SLASH_INSIGHT_CAPTURE']
    if (insightPath) {
      void import('./dev/spikeCapture').then(({ runInsightCapture }) =>
        runInsightCapture(window, insightPath, {
          analyse: () => context.insight.analyse(window.tabs.activeTab?.contents ?? null)
        })
      )
    }

    const cleanupPath = process.env['SLASH_CLEANUP_CAPTURE']
    if (cleanupPath) {
      void import('./dev/spikeCapture').then(({ runCleanupCapture }) => {
        const contents = () => window.tabs.activeTab?.contents ?? null
        const evaluate = async (expression: string): Promise<number> => {
          const target = contents()
          if (!target) return 0
          return (await target.executeJavaScript(expression, true)) as number
        }
        return runCleanupCapture(window, cleanupPath, {
          apply: (mode) => context.cleanup.apply(window.tabs.activeTab?.id ?? '', contents(), mode),
          restore: () => context.cleanup.restore(window.tabs.activeTab?.id ?? '', contents()),
          // No whitespace normalisation: the probe compares this figure against
          // itself before and after cleaning, so consistency is all that matters
          // and a regex inside a nested string literal is an escaping hazard for
          // no benefit.
          contentLength: () =>
            evaluate(
              "(document.querySelector('main, article, #content') || document.body).innerText.trim().length"
            ),
          hiddenCount: () => evaluate("document.querySelectorAll('.slash-cleanup-hidden').length")
        })
      })
    }

    const tabBrainPath = process.env['SLASH_TABBRAIN_CAPTURE']
    if (tabBrainPath) {
      void Promise.all([
        import('./dev/spikeCapture'),
        import('./tabs/brain/tabAnalysis')
      ]).then(([{ runTabBrainCapture }, { analyseTabs }]) =>
        runTabBrainCapture(window, tabBrainPath, {
          analyse: () =>
            analyseTabs(window.tabs.allTabs().map((tab) => tab.snapshot), Date.now()),
          titleOf: (tabId) => window.tabs.findById(tabId)?.snapshot.title ?? '(gone)'
        })
      )
    }

    if (process.env['SLASH_GUARDIAN_PROBE']) {
      void import('./dev/spikeCapture').then(({ runGuardianCapture }) =>
        runGuardianCapture(window, {
          scanDownloads: () => context.guardian.scanDownloads(window.tabs.activeTab?.contents ?? null),
          scanMedia: () => context.guardian.scanMedia(window.tabs.activeTab?.contents ?? null)
        })
      )
    }

    if (process.env['SLASH_DOWNLOAD_PROBE']) {
      void Promise.all([
        import('./dev/spikeCapture'),
        import('./downloads/engine/SegmentedDownload'),
        import('./downloads/engine/planning'),
        import('node:os'),
        import('node:fs')
      ]).then(async ([{ runDownloadEngineCapture }, { SegmentedDownload }, { planConnections }, os, fs]) => {
        const tempDir = fs.mkdtempSync(`${os.tmpdir()}/slash-dl-`)
        const { createServer } = await import('node:http')

        // Deterministic bytes, so a reassembly bug shows up as a checksum
        // mismatch rather than as "it looked fine".
        const big = Buffer.alloc(12 * 1024 * 1024)
        for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 16)) & 0xff
        const small = big.subarray(0, 64 * 1024)

        const server = createServer((request, response) => {
          const plain = request.url === '/plain.bin'
          const body = request.url === '/small.bin' ? small : big
          const range = plain ? undefined : request.headers.range

          if (!plain) response.setHeader('Accept-Ranges', 'bytes')
          response.setHeader('Content-Type', 'application/octet-stream')
          response.setHeader('ETag', '"probe-fixture-v1"')

          const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
          if (match) {
            const start = Number(match[1])
            const end = match[2] ? Number(match[2]) : body.length - 1
            response.statusCode = 206
            response.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`)
            response.setHeader('Content-Length', String(end - start + 1))
            response.end(body.subarray(start, end + 1))
            return
          }
          response.statusCode = 200
          response.setHeader('Content-Length', String(body.length))
          response.end(body)
        })

        const baseUrl = await new Promise<string>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
          })
        })

        return runDownloadEngineCapture({
          tempDir,
          baseUrl,
          download: async (url, destination, connections) => {
            const download = new SegmentedDownload({
              url,
              destination,
              connections,
              onProgress: () => {}
            })
            const capabilities = await download.probe()
            const plan = planConnections(capabilities, connections)
            await download.run(capabilities.totalBytes, plan.connections)
            return {
              receivedBytes: download.receivedBytes,
              totalBytes: capabilities.totalBytes,
              segments: download.currentSegments.length,
              note: plan.note,
              checksum: await download.checksum(),
              acceptsRanges: capabilities.acceptsRanges
            }
          }
        })
      })
    }

    const featuresPath = process.env['SLASH_FEATURES_CAPTURE']
    if (featuresPath) {
      void import('./dev/spikeCapture').then(({ runFeaturesCapture }) =>
        runFeaturesCapture(window, featuresPath, {
          setVerticalTabs: (on) =>
            context.settings.update({ tabStripPosition: on ? 'left' : 'top' }),
          activeError: () => window.tabs.activeTab?.snapshot.error ?? null,
          isViewAttached: () => window.tabs.hasAttachedView,
          readArticle: async () => {
            const result = await context.reader.extract(window.tabs.activeTab?.contents ?? null)
            return {
              ok: result.article !== null,
              title: result.article?.title ?? '',
              blocks: result.article?.blocks.length ?? 0,
              reason: result.reason
            }
          },
          tabCount: () => window.tabs.allTabs().length
        })
      )
    }

    if (process.env['SLASH_IMPORT_PROBE']) {
      void import('./dev/spikeCapture').then(({ runImportCapture }) =>
        runImportCapture({
          discover: () => context.importer.discover(),
          run: (id) => context.importer.run(id, { bookmarks: true, history: true }),
          bookmarkCount: () => context.bookmarks.list().length,
          historyCount: () => context.history.search('', 100000, 0).length
        })
      )
    }

    const semanticPath = process.env['SLASH_SEMANTIC_CAPTURE']
    if (semanticPath) {
      void import('./dev/spikeCapture').then(({ runSemanticCapture }) =>
        runSemanticCapture(window, semanticPath, {
          setIndexing: (history, content) =>
            context.settings.update({ indexHistory: history, indexPageContent: content }),
          enableSemantic: () => context.semantic.enable(),
          disableSemantic: () => context.semantic.disable(),
          status: () => context.semantic.status(),
          search: (query) => context.memorySearch.search(parseQueryForDev(query), 10),
          // Straight to the repository, bypassing fusion: this is the control
          // case, and it has to be the keyword index alone or the comparison
          // proves nothing.
          keywordOnly: (query) => context.memoryRepository.search(parseQueryForDev(query), 10),
          forget: (url) => context.memoryRepository.forget(url),
          clear: () => context.memoryRepository.clearAll()
        })
      )
    }

    const snapshotMode = process.env['ADAPTIVE_SNAPSHOT_CAPTURE']
    if (snapshotMode) {
      void import('./dev/spikeCapture').then(({ runSnapshotCapture }) =>
        runSnapshotCapture(window, process.env['ADAPTIVE_SNAPSHOT_OUT'] ?? 'snapshot.png', snapshotMode)
      )
    }

    const permPath = process.env['ADAPTIVE_PERMISSION_CAPTURE']
    if (permPath) {
      void import('./dev/spikeCapture').then(({ runPermissionCapture }) =>
        runPermissionCapture(window, permPath, {
          respond: (requestId, policy) => context.permissions.respond(requestId, policy),
          pendingIds: () => (window.pendingPermission ? [window.pendingPermission.requestId] : [])
        })
      )
    }

    const perfPath = process.env['ADAPTIVE_PERF_CAPTURE']
    if (perfPath) {
      void import('./dev/spikeCapture').then(({ runPerformanceCapture }) =>
        runPerformanceCapture(window, perfPath)
      )
    }

    const uiPath = process.env['ADAPTIVE_UI_CAPTURE']
    if (uiPath) {
      void import('./dev/spikeCapture').then(({ runUiCapture }) =>
        runUiCapture(context, window, uiPath)
      )
    }

    app.on('activate', () => {
      if (context.windowCount === 0) context.createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * Record the session before quitting.
   *
   * `will-quit` is too late and, more importantly, synchronous — capturing scroll
   * position means asking each live renderer, which is async. So the first quit
   * is deferred: take the snapshot, then quit for real. The `quitting` flag stops
   * the second pass from deferring again and hanging the app.
   */
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void context.snapshots
      .capture('session-end')
      .catch((error: unknown) => log.error('failed to record the closing session', error))
      .finally(() => app.quit())
  })

  // `will-quit` rather than `quit`: this is the last point at which the SQLite
  // checkpoint can still run.
  app.on('will-quit', () => context.shutdown())

  process.on('uncaughtException', (error) => {
    log.error('uncaught exception in main', error)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection in main', reason)
  })
}
