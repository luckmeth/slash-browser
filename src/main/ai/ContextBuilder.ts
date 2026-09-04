import type { EgressPreview } from '@shared/types/ai'
import type { Tab } from '@shared/types/tab'
import { isInternalUrl } from '@shared/types/tab'
import type { Workspace } from '@shared/types/workspace'
import { hostOf, originOf } from '@shared/url'

/** Titles are truncated so one absurd title cannot dominate the request. */
const MAX_TITLE_CHARS = 120

export interface ContextInput {
  tabs: readonly Tab[]
  workspaces: readonly Workspace[]
  activeWorkspaceId: string
  /** Origins the user excluded from Web Memory. Honoured here too. */
  excludedOrigins: readonly string[]
  /** Only true when the user opted in for this specific request. */
  includePageContent: boolean
  /** Extracted text by tab id, supplied only when includePageContent is true. */
  pageText?: ReadonlyMap<string, string>
}

/**
 * The single path by which anything reaches an AI provider.
 *
 * Everything the model sees is assembled here, and `preview()` describes exactly
 * that same payload for the user. Keeping construction and disclosure in one
 * place is what stops them drifting apart — a privacy promise made in the UI but
 * enforced somewhere else is a promise waiting to be broken.
 *
 * By default this is titles and URLs only. Page *text* requires a separate,
 * per-request opt-in, and excluded origins are dropped either way.
 */
export class ContextBuilder {
  constructor(private readonly input: ContextInput) {}

  /** Tabs eligible to be described, after exclusions. */
  private eligibleTabs(): Tab[] {
    return this.input.tabs.filter((tab) => {
      if (isInternalUrl(tab.url)) return false
      if (!/^https?:\/\//i.test(tab.url)) return false
      const origin = originOf(tab.url)
      return !this.input.excludedOrigins.some(
        (excluded) => origin === excluded || tab.url.startsWith(excluded)
      )
    })
  }

  build(): string {
    const tabs = this.eligibleTabs()
    const workspaces = this.input.workspaces

    const lines: string[] = []
    lines.push('Workspaces:')
    for (const workspace of workspaces) {
      lines.push(
        `- id=${workspace.id} name=${JSON.stringify(workspace.name)}` +
          (workspace.id === this.input.activeWorkspaceId ? ' (active)' : '')
      )
    }

    lines.push('', 'Open tabs:')
    for (const tab of tabs) {
      const title = tab.title.slice(0, MAX_TITLE_CHARS)
      lines.push(
        `- id=${tab.id} workspace=${tab.workspaceId} host=${hostOf(tab.url)} ` +
          `title=${JSON.stringify(title)}`
      )
      if (this.input.includePageContent) {
        const text = this.input.pageText?.get(tab.id)
        if (text) lines.push(`  excerpt=${JSON.stringify(text.slice(0, 500))}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Human-readable description of the payload above.
   *
   * Derived from the same eligibility rules, so it cannot understate what is
   * being sent.
   */
  preview(): EgressPreview {
    const tabs = this.eligibleTabs()
    const excluded = this.input.tabs.length - tabs.length

    const lines = [
      `${tabs.length} open ${tabs.length === 1 ? 'tab' : 'tabs'}: the site name and page title of each`,
      `${this.input.workspaces.length} workspace names`
    ]
    if (this.input.includePageContent) {
      lines.push('the first 500 characters of text from each of those pages')
    } else {
      lines.push('no page text — only titles and site names')
    }
    if (excluded > 0) {
      lines.push(`${excluded} tab(s) excluded and not described at all`)
    }
    lines.push('your typed request')
    lines.push('No cookies, form data, passwords, history or bookmarks are included.')

    return {
      tabCount: tabs.length,
      includesPageContent: this.input.includePageContent,
      lines
    }
  }
}
