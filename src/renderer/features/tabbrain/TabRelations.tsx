import { useMemo, useState } from 'react'
import { buildRelations, countTabs, type RelationNode } from '@shared/tabRelations'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * The shape of what is open, as a tree you can click through.
 *
 * A navigation view, not an understanding one. Every branch is a site and every
 * twig is a section of that site's own address — facts the browser already
 * holds. There is no topic modelling and nothing is inferred about what the
 * tabs mean, because an address does not tell you that and claiming otherwise
 * would be the hallucination engine the spec asks this not to be.
 *
 * `buildRelations` is pure and tested, and the invariant that matters is
 * asserted there: no tab is lost. This exists to find a tab among forty, so a
 * tab the tree quietly forgot would be the whole feature failing.
 */
export function TabRelations(): React.JSX.Element | null {
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const branches = useMemo(
    () =>
      buildRelations(
        tabs
          .filter((tab) => !isInternalUrl(tab.url))
          .map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            workspaceId: tab.workspaceId,
            isActive: tab.id === activeTabId
          }))
      ),
    [tabs, activeTabId]
  )

  if (branches.length === 0) return null

  const total = countTabs(branches)
  const toggle = (key: string): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const renderNode = (node: RelationNode, depth: number): React.JSX.Element => {
    if (node.kind === 'tab') {
      return (
        <li key={node.tab.id} style={{ paddingLeft: depth * 12 }}>
          <button
            type="button"
            onClick={() => void window.browser.invoke('tabs:activate', { tabId: node.tab.id })}
            title={node.tab.url}
            className={`flex w-full cursor-default items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition hover:bg-white/[0.06] ${
              node.tab.isActive ? 'text-[var(--color-accent)]' : ''
            }`}
          >
            <Icon name="globe" size={11} className="shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1 truncate">
              {node.tab.title || hostOf(node.tab.url)}
            </span>
          </button>
        </li>
      )
    }

    const isCollapsed = collapsed.has(node.key)
    return (
      <li key={node.key} style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          onClick={() => toggle(node.key)}
          aria-expanded={!isCollapsed}
          className="flex w-full cursor-default items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition hover:bg-white/[0.06]"
        >
          <Icon
            name={isCollapsed ? 'forward' : 'expand'}
            size={11}
            className="shrink-0 text-[var(--color-text-muted)]"
          />
          <span className="min-w-0 flex-1 truncate font-medium">{node.label}</span>
          <span className="shrink-0 tabular-nums text-[10px] text-[var(--color-text-muted)]">
            {node.count}
          </span>
        </button>
        {/*
          Collapsing hides the rows and nothing else. The tabs keep their views
          and are exactly as open as they were — the same rule tab groups
          follow, where collapsing is deliberately not sleeping.
        */}
        {!isCollapsed && (
          <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        )}
      </li>
    )
  }

  return (
    <section className="border-t border-[var(--color-border-subtle)] p-4">
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
        How your tabs relate
      </h3>
      <p className="mb-2 text-xs text-[var(--color-text-muted)]">
        {total} {total === 1 ? 'tab' : 'tabs'} across {branches.length}{' '}
        {branches.length === 1 ? 'site' : 'sites'}, grouped by address. Nothing here is inferred
        about what the pages are about.
      </p>
      <ul>{branches.map((branch) => renderNode(branch, 0))}</ul>
    </section>
  )
}
