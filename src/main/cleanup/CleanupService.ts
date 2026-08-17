import { z } from 'zod'
import type { WebContents } from 'electron'
import type { CleanupMode, CleanupResult } from '@shared/types/cleanup'
import { createLogger } from '../logger'
import { describeResult, planCleanup } from './cleanupRules'
import { buildCleanupScript, buildRestoreScript } from './cleanupScript'

const log = createLogger('cleanup')

/** What the injected pass is allowed to report back. */
const PassSchema = z.object({
  hidden: z.number().int().min(0).catch(0),
  paused: z.number().int().min(0).catch(0),
  scrollUnlocked: z.boolean().catch(false)
})

/**
 * Applies and undoes Cleanup Mode.
 *
 * Per-tab state is held here rather than in the page, because the page is
 * exactly the thing that may be hostile: a site that wanted to defeat cleanup
 * could clear a flag it could see. Main remembers which tabs it has cleaned, and
 * a navigation clears that memory since the new document was never touched.
 */
export class CleanupService {
  private readonly cleaned = new Map<string, CleanupResult>()

  /** Runs a cleanup pass on a tab's page. */
  async apply(
    tabId: string,
    contents: WebContents | null,
    mode: CleanupMode
  ): Promise<CleanupResult> {
    const plan = planCleanup(mode)
    if (!contents || contents.isDestroyed() || !/^https?:\/\//i.test(contents.getURL())) {
      return {
        applied: false,
        mode,
        hidden: 0,
        paused: 0,
        scrollUnlocked: false,
        detail: 'Cleanup works on web pages only.'
      }
    }

    try {
      const raw: unknown = await contents.executeJavaScript(buildCleanupScript(plan), true)
      const pass = PassSchema.safeParse(raw)
      if (!pass.success) {
        return {
          applied: false,
          mode,
          hidden: 0,
          paused: 0,
          scrollUnlocked: false,
          detail: 'This page could not be cleaned.'
        }
      }

      const result: CleanupResult = {
        applied: true,
        mode,
        hidden: pass.data.hidden,
        paused: pass.data.paused,
        scrollUnlocked: pass.data.scrollUnlocked,
        detail: describeResult(pass.data.hidden, pass.data.paused, pass.data.scrollUnlocked)
      }
      this.cleaned.set(tabId, result)
      log.info(`cleaned ${contents.getURL().slice(0, 60)} (${mode}): ${result.detail}`)
      return result
    } catch (error) {
      log.warn('cleanup pass threw', error)
      return {
        applied: false,
        mode,
        hidden: 0,
        paused: 0,
        scrollUnlocked: false,
        detail: 'This page could not be cleaned.'
      }
    }
  }

  /** Puts back everything a pass hid. */
  async restore(tabId: string, contents: WebContents | null): Promise<void> {
    this.cleaned.delete(tabId)
    if (!contents || contents.isDestroyed()) return
    try {
      await contents.executeJavaScript(buildRestoreScript(), true)
    } catch (error) {
      // A page that navigated away has already restored itself; the new document
      // was never cleaned.
      log.debug('restore threw (page probably navigated)', error)
    }
  }

  /** The last result for a tab, or null if it has not been cleaned. */
  resultFor(tabId: string): CleanupResult | null {
    return this.cleaned.get(tabId) ?? null
  }

  /**
   * Forgets a tab's cleanup state.
   *
   * Called on navigation: the new document has none of the injected CSS, so
   * continuing to report the tab as cleaned would be wrong, and offering Restore
   * would do nothing.
   */
  forget(tabId: string): void {
    this.cleaned.delete(tabId)
  }
}
