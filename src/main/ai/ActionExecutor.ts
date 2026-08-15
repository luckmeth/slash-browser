import type { BrowserAction, PreviewLine } from '@shared/types/ai'
import { hostOf } from '@shared/url'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import type { WorkspaceRepository } from '../db/repositories/WorkspaceRepository'
import type { BookmarkRepository } from '../db/repositories/BookmarkRepository'
import { createLogger } from '../logger'

const log = createLogger('ai')

export interface ExecutionResult {
  applied: number
  skipped: number
  messages: string[]
  /** Set when the actions can be reversed. */
  undo: (() => void) | null
}

/**
 * Carries out an approved plan.
 *
 * **This is the safety boundary, and it is structural rather than advisory.**
 * The switch below is exhaustive over `BrowserAction`, so the executor can reach
 * no browser capability that is not a declared variant. Sending a message,
 * making a purchase, submitting a form, changing a security setting, granting a
 * permission, deleting history — none of these exist as variants, so no prompt,
 * no jailbreak and no malformed payload can invoke them. A model that asks for
 * one produces JSON that fails zod parsing before it ever arrives here.
 *
 * Every action is also reversible or non-destructive: closed tabs go onto the
 * reopen stack, moves can be moved back.
 */
export class ActionExecutor {
  constructor(
    private readonly window: BrowserWindowController,
    private readonly workspaces: WorkspaceRepository,
    private readonly bookmarks: BookmarkRepository
  ) {}

  /**
   * Describes what a plan would do, without doing any of it.
   *
   * Built from the same action objects the executor consumes, so the preview
   * cannot describe something different from what runs.
   */
  preview(actions: readonly BrowserAction[]): PreviewLine[] {
    const lines: PreviewLine[] = []
    const titleOf = (tabId: string): string => {
      const tab = this.window.tabs.findById(tabId)
      if (!tab) return 'a tab that is no longer open'
      return tab.snapshot.title || hostOf(tab.snapshot.url)
    }

    for (const action of actions) {
      switch (action.kind) {
        case 'organize-tabs':
          for (const group of action.groups) {
            lines.push({
              text: `Group “${group.name}”: ${group.tabIds.length} tabs — ${group.tabIds.map(titleOf).slice(0, 3).join(', ')}${group.tabIds.length > 3 ? '…' : ''}`,
              tabIds: group.tabIds,
              mutating: true
            })
          }
          break
        case 'create-workspace':
          lines.push({
            text: `Create workspace ${action.icon} “${action.name}” and move ${action.tabIds.length} tabs into it`,
            tabIds: action.tabIds,
            mutating: true
          })
          break
        case 'move-tabs': {
          const target = this.workspaces.findById(action.toWorkspaceId)
          lines.push({
            text: `Move ${action.tabIds.length} tabs to “${target?.name ?? 'unknown workspace'}”`,
            tabIds: action.tabIds,
            mutating: true
          })
          break
        }
        case 'close-tabs':
          lines.push({
            text: `Close ${action.tabIds.length} tabs (${action.reason}). Reopen with Ctrl+Shift+T.`,
            tabIds: action.tabIds,
            mutating: true
          })
          break
        case 'save-tabs':
          lines.push({
            text: `Bookmark ${action.tabIds.length} tabs into “${action.toBookmarkFolder}”`,
            tabIds: action.tabIds,
            mutating: false
          })
          break
        case 'reading-queue':
          lines.push({
            text: `Order ${action.orderedTabIds.length} tabs as a reading queue`,
            tabIds: action.orderedTabIds,
            mutating: true
          })
          break
      }
    }
    return lines
  }

  execute(actions: readonly BrowserAction[]): ExecutionResult {
    const messages: string[] = []
    const undoSteps: Array<() => void> = []
    let applied = 0
    let skipped = 0

    /** Tabs can close between proposal and approval; that is not an error. */
    const liveTabs = (ids: readonly string[]): string[] =>
      ids.filter((id) => this.window.tabs.findById(id) !== null)

    for (const action of actions) {
      switch (action.kind) {
        case 'organize-tabs': {
          for (const group of action.groups) {
            const ids = liveTabs(group.tabIds)
            if (ids.length === 0) {
              skipped += 1
              continue
            }
            const workspace = this.workspaces.create({
              name: group.name,
              icon: '📁',
              color: 'slate',
              // Never isolated: an isolated workspace has its own cookie
              // partition, so moving tabs in would sign them all out. The AI
              // must not be able to cause that as a side effect.
              isolated: false
            })
            const previous = ids.map((id) => ({
              id,
              from: this.window.tabs.findById(id)?.snapshot.workspaceId ?? ''
            }))
            for (const id of ids) this.window.tabs.moveToWorkspace(id, workspace.id)
            undoSteps.push(() => {
              for (const entry of previous) this.window.tabs.moveToWorkspace(entry.id, entry.from)
              this.workspaces.delete(workspace.id)
            })
            applied += 1
            messages.push(`Created “${group.name}” with ${ids.length} tabs`)
          }
          break
        }

        case 'create-workspace': {
          const ids = liveTabs(action.tabIds)
          const workspace = this.workspaces.create({
            name: action.name,
            icon: action.icon,
            color: 'slate',
            isolated: false
          })
          const previous = ids.map((id) => ({
            id,
            from: this.window.tabs.findById(id)?.snapshot.workspaceId ?? ''
          }))
          for (const id of ids) this.window.tabs.moveToWorkspace(id, workspace.id)
          undoSteps.push(() => {
            for (const entry of previous) this.window.tabs.moveToWorkspace(entry.id, entry.from)
            this.workspaces.delete(workspace.id)
          })
          applied += 1
          messages.push(`Created “${action.name}”`)
          break
        }

        case 'move-tabs': {
          const target = this.workspaces.findById(action.toWorkspaceId)
          if (!target) {
            skipped += 1
            messages.push('Skipped a move to a workspace that does not exist')
            break
          }
          // Refuse to move into an isolated workspace: it would silently sign
          // every moved tab out, which is not something to do without the user
          // seeing the specific warning the manual path shows.
          if (target.isolated) {
            skipped += 1
            messages.push(
              `Skipped moving tabs into “${target.name}” — it is isolated, so the move would sign them out. Do it manually if that is what you want.`
            )
            break
          }
          const ids = liveTabs(action.tabIds)
          const previous = ids.map((id) => ({
            id,
            from: this.window.tabs.findById(id)?.snapshot.workspaceId ?? ''
          }))
          for (const id of ids) this.window.tabs.moveToWorkspace(id, target.id)
          undoSteps.push(() => {
            for (const entry of previous) this.window.tabs.moveToWorkspace(entry.id, entry.from)
          })
          applied += 1
          messages.push(`Moved ${ids.length} tabs to “${target.name}”`)
          break
        }

        case 'close-tabs': {
          const ids = liveTabs(action.tabIds)
          for (const id of ids) this.window.tabs.close(id)
          // Closing is already reversible through the reopen stack, which is
          // where these went.
          undoSteps.push(() => {
            for (let i = 0; i < ids.length; i += 1) this.window.tabs.reopenClosed()
          })
          applied += 1
          messages.push(`Closed ${ids.length} tabs — Ctrl+Shift+T reopens them`)
          break
        }

        case 'save-tabs': {
          const ids = liveTabs(action.tabIds)
          const folder = this.bookmarks.create({
            url: '',
            title: action.toBookmarkFolder,
            faviconUrl: null,
            parentId: null,
            isFolder: true
          })
          for (const id of ids) {
            const tab = this.window.tabs.findById(id)
            if (!tab) continue
            this.bookmarks.create({
              url: tab.snapshot.url,
              title: tab.snapshot.title || hostOf(tab.snapshot.url),
              faviconUrl: tab.snapshot.faviconUrl,
              parentId: folder.id,
              isFolder: false
            })
          }
          undoSteps.push(() => this.bookmarks.delete(folder.id))
          applied += 1
          messages.push(`Bookmarked ${ids.length} tabs into “${action.toBookmarkFolder}”`)
          break
        }

        case 'reading-queue': {
          const ids = liveTabs(action.orderedTabIds)
          ids.forEach((id, index) => this.window.tabs.reorder(id, index))
          applied += 1
          messages.push(`Ordered ${ids.length} tabs as a reading queue`)
          break
        }
      }
    }

    this.window.tabs.emitNow()
    log.info(`executed ${applied} action(s), skipped ${skipped}`)

    return {
      applied,
      skipped,
      messages,
      undo:
        undoSteps.length > 0
          ? () => {
              // Reverse order, so nested effects unwind correctly.
              for (const step of [...undoSteps].reverse()) step()
              this.window.tabs.emitNow()
            }
          : null
    }
  }
}
