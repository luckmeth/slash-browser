import type { PageFacts } from '@shared/compareTabs'
import { MAX_COMPARE_TABS } from '@shared/compareTabs'
import { createLogger } from '../logger'
import { COMPARE_SCRIPT } from './compareScript'

const log = createLogger('compare')

/** What a tab must offer for this service to read it. */
export interface ComparableTab {
  readonly id: string
  readonly url: string
  readonly title: string
  /** Null for a hibernated or internal tab — nothing to read. */
  readonly execute: ((script: string) => Promise<unknown>) | null
}

/**
 * Reads what several pages say about themselves, so they can be compared.
 *
 * Runs only on the user's click, and only against tabs that have a live
 * renderer. A hibernated tab is reported as unreadable rather than woken: waking
 * one to read a table would reload a page somebody had put to sleep, and the
 * comparison is not worth that.
 *
 * `executeJavaScript` in the page's own world is the same capability
 * `PageMediaExtractor` uses and is kept to the same shape — one script, on a
 * click, reading and changing nothing. It is deliberately not in
 * `preload/content.ts`, which this project keeps to scroll position and
 * Readability.
 */
export class TabCompareService {
  async read(tabs: readonly ComparableTab[]): Promise<{
    facts: PageFacts[]
    /** Tabs that could not be read, with the reason, so the UI can say which. */
    unreadable: { tabId: string; title: string; reason: string }[]
  }> {
    const chosen = tabs.slice(0, MAX_COMPARE_TABS)
    const facts: PageFacts[] = []
    const unreadable: { tabId: string; title: string; reason: string }[] = []

    for (const tab of chosen) {
      if (!tab.execute) {
        unreadable.push({
          tabId: tab.id,
          title: tab.title,
          reason: 'Asleep or an internal page — nothing to read without reloading it.'
        })
        continue
      }

      try {
        const raw: unknown = await tab.execute(COMPARE_SCRIPT)
        if (!raw || typeof raw !== 'object') {
          unreadable.push({
            tabId: tab.id,
            title: tab.title,
            reason: 'The page did not answer.'
          })
          continue
        }
        facts.push(toFacts(tab, raw as Record<string, unknown>))
      } catch (error) {
        // A page that refuses to run a script is not an error condition — some
        // do, and the comparison shows the rest rather than failing entirely.
        log.debug(`could not read ${tab.id}`, error)
        unreadable.push({
          tabId: tab.id,
          title: tab.title,
          reason: 'The page refused to be read.'
        })
      }
    }

    return { facts, unreadable }
  }
}

/**
 * Narrows whatever the page returned to the shape the comparison expects.
 *
 * Everything here crossed out of a web page's own world, so nothing is trusted:
 * each field is checked rather than cast, and anything unexpected becomes the
 * empty case instead of reaching the renderer as an unknown shape.
 */
function toFacts(tab: ComparableTab, raw: Record<string, unknown>): PageFacts {
  const fields: Record<string, string> = {}
  if (raw.fields && typeof raw.fields === 'object') {
    for (const [key, value] of Object.entries(raw.fields as Record<string, unknown>)) {
      if (typeof key === 'string' && typeof value === 'string') fields[key] = value
    }
  }

  const headings = Array.isArray(raw.headings)
    ? raw.headings.filter((item): item is string => typeof item === 'string').slice(0, 12)
    : []

  return {
    tabId: tab.id,
    url: tab.url,
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : tab.title,
    description: typeof raw.description === 'string' ? raw.description : null,
    siteName: typeof raw.siteName === 'string' ? raw.siteName : null,
    fields,
    headings,
    wordCount: typeof raw.wordCount === 'number' && raw.wordCount >= 0 ? raw.wordCount : 0
  }
}
