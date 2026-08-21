import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, utilityProcess } from 'electron'
import { FiltersEngine, Request as AdRequest } from '@ghostery/adblocker'
import { mapResourceType } from './resourceTypes'
import { createLogger } from '../../logger'
import { fingerprintLists } from './compiler'

const log = createLogger('adblock')

/** Where the bundled lists live — beside app.asar, never inside it. */
function listsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'filters')
    : join(app.getAppPath(), 'resources', 'filters')
}

/**
 * Full filter-list blocking: EasyList syntax, cosmetic rules, the lot.
 *
 * Runs **alongside** `FilterEngine` rather than replacing it. The old engine
 * still owns three things this cannot do: the malicious-site list, per-site
 * allow decisions, and the host+path rules that reach first-party ad endpoints
 * like `youtube.com/ptracking`, which no domain list can express.
 *
 * Loading is asynchronous and failure is silent-but-logged. Until it is ready —
 * and forever, if the lists are missing — `matches()` returns false and Slash
 * behaves exactly as it did before. A blocker that cannot start must not also
 * stop the browser from working.
 */
export class AdblockEngine {
  private engine: FiltersEngine | null = null
  private loading: Promise<void> | null = null

  get ready(): boolean {
    return this.engine !== null
  }

  /**
   * Loads the engine, compiling the lists first if the cache is stale.
   *
   * Deliberately not awaited by the caller at startup: the browser opens and
   * browses fine without it, and the old engine covers the gap.
   */
  load(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = this.doLoad().catch((error: unknown) => {
      log.warn('filter engine unavailable; falling back to the domain lists', error)
    })
    return this.loading
  }

  private async doLoad(): Promise<void> {
    const dir = listsDir()
    if (!existsSync(dir)) {
      log.warn(`no filter lists at ${dir}`)
      return
    }

    const cachePath = join(app.getPath('userData'), 'filters.bin')
    const stampPath = join(app.getPath('userData'), 'filters.stamp')
    const expected = fingerprintLists(dir)

    const cached =
      existsSync(cachePath) &&
      existsSync(stampPath) &&
      readFileSync(stampPath, 'utf8').trim() === expected

    if (!cached) {
      log.info('compiling filter lists (first run or lists changed)')
      await this.compile(dir, cachePath, stampPath, expected)
    }

    if (!existsSync(cachePath)) return

    const started = Date.now()
    this.engine = FiltersEngine.deserialize(readFileSync(cachePath))
    log.info(`filter engine ready in ${Date.now() - started}ms`)
  }

  /** Runs the parser in a utility process and waits for it to finish. */
  private compile(
    dir: string,
    cachePath: string,
    stampPath: string,
    expected: string
  ): Promise<void> {
    return new Promise((resolve) => {
      const child = utilityProcess.fork(join(__dirname, 'filterCompiler.js'), [], {
        serviceName: 'slash-filters',
        stdio: 'inherit'
      })

      // A compile that never returns must not leave the shield permanently
      // half-built; the domain lists keep working either way.
      const timer = setTimeout(() => {
        log.warn('filter compile timed out')
        child.kill()
        resolve()
      }, 60_000)

      child.on('message', (raw: unknown) => {
        const result = raw as { kind?: string; bytes?: number; ms?: number; error?: string }
        clearTimeout(timer)
        if (result?.kind === 'compiled') {
          writeFileSync(stampPath, expected, 'utf8')
          log.info(
            `compiled filters in ${result.ms}ms (${((result.bytes ?? 0) / 1048576).toFixed(2)} MB)`
          )
        } else {
          log.warn(`filter compile failed: ${result?.error ?? 'unknown'}`)
        }
        child.kill()
        resolve()
      })

      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })

      child.postMessage({ kind: 'compile', listsDir: dir, cachePath })
    })
  }

  /**
   * Whether this request should be cancelled.
   *
   * The request *type* is not incidental: filter lists lean on it heavily
   * (`$script`, `$image`, `$third-party`), so getting the mapping wrong quietly
   * changes which rules apply rather than failing loudly.
   */
  matches(url: string, sourceUrl: string, resourceType: string): boolean {
    if (!this.engine) return false
    try {
      const request = AdRequest.fromRawDetails({
        url,
        sourceUrl,
        type: mapResourceType(resourceType)
      })
      return this.engine.match(request).match
    } catch {
      // A malformed URL is not a reason to break a page load.
      return false
    }
  }

  /**
   * The stylesheet that hides this page's ad slots, or empty.
   *
   * Returned as CSS text for `webContents.insertCSS`, which is a first-class
   * Electron API needing no preload and no main-world script — that is what
   * lets Slash have cosmetic filtering without widening what `preload/content.ts`
   * is allowed to do.
   */
  cosmeticStylesFor(url: string, hostname: string, domain: string): string {
    if (!this.engine) return ''
    try {
      return this.engine.getCosmeticsFilters({ url, hostname, domain }).styles ?? ''
    } catch {
      return ''
    }
  }
}
