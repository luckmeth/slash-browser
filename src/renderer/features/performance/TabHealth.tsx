import { useMemo, useState } from 'react'
import type { PerformanceSnapshot } from '@shared/types/performance'
import type { Tab } from '@shared/types/tab'
import { isInternalUrl } from '@shared/types/tab'
import { hostOf } from '@shared/url'
import {
  summariseTabHealth,
  memoryCaption,
  formatBytes,
  type HealthState
} from '@shared/tabHealth'
import {
  findDuplicateGroups,
  duplicateCloseIds,
  DUPLICATE_REASON_LABEL
} from '@shared/tabDuplicates'

/**
 * Tab Health: the shape of the window in five numbers, and what can be done.
 *
 * The figures come from `summariseTabHealth`, which is pure and tested because
 * the one thing a view like this must not do is merge *measured* bytes with
 * *projected* ones. Freed memory is a fact recorded immediately before a
 * renderer was destroyed; an opportunity is a guess about processes that are
 * still running, and they are reported as two separate sentences.
 *
 * Nothing here acts without being clicked. "Hibernate safe tabs" goes through
 * `performance:applyRecommendation`, which re-checks every guard in main — so a
 * tab that started playing audio between the render and the click is refused
 * rather than slept, and the count says how many were actually applied.
 */
export function TabHealth({
  snapshot,
  tabs,
  onNotice
}: {
  snapshot: PerformanceSnapshot
  tabs: readonly Tab[]
  onNotice: (text: string) => void
}): React.JSX.Element {
  const [reviewing, setReviewing] = useState<'idle' | 'duplicates' | 'heavy' | null>(null)

  const duplicateGroups = useMemo(
    () =>
      findDuplicateGroups(
        tabs.map((tab) => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          lastActiveAt: tab.lastActiveAt,
          isPinned: tab.isPinned,
          isProtected: tab.isProtected
        }))
      ),
    [tabs]
  )

  const health = useMemo(
    () =>
      summariseTabHealth(
        snapshot.tabs.map((metric) => ({
          tabId: metric.tabId,
          state: healthStateOf(metric.state),
          memoryBytes: metric.memoryBytes,
          measuredSavingsBytes: metric.measuredSavingsBytes,
          blockers: metric.blockers,
          sharedProcess: metric.sharedProcess
        })),
        duplicateCloseIds(duplicateGroups).length
      ),
    [snapshot.tabs, duplicateGroups]
  )

  const titleFor = (tabId: string): string => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return 'Tab in another workspace'
    if (isInternalUrl(tab.url)) return 'New tab'
    return tab.title || hostOf(tab.url) || 'Untitled'
  }

  const hibernate = (tabIds: readonly string[], what: string): void => {
    if (tabIds.length === 0) return
    void window.browser
      .invoke('performance:applyRecommendation', { tabIds: [...tabIds] })
      .then((result) => {
        if (!result.ok) return
        onNotice(
          `Hibernated ${result.value.applied} of ${tabIds.length} ${what}.` +
            // The guards run again in main at the moment of the click, so a
            // shortfall is a real thing that happened rather than an error.
            (result.value.applied < tabIds.length
              ? ' The rest became unsafe to sleep in the meantime.'
              : '')
        )
      })
  }

  const closeDuplicates = (): void => {
    const ids = duplicateCloseIds(duplicateGroups)
    if (ids.length === 0) return
    for (const tabId of ids) void window.browser.invoke('tabs:close', { tabId })
    onNotice(
      `Closed ${ids.length} duplicate ${ids.length === 1 ? 'tab' : 'tabs'}. ` +
        'Reopen any of them with Ctrl+Shift+T.'
    )
  }

  const heavy = useMemo(
    () =>
      [...snapshot.tabs]
        .filter((metric) => metric.memoryBytes !== null && metric.memoryBytes > 0)
        .sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))
        .slice(0, 5),
    [snapshot.tabs]
  )

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
        Tab health
      </h3>

      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
        <p className="text-sm">
          <strong className="tabular-nums">{health.total}</strong>{' '}
          {health.total === 1 ? 'tab' : 'tabs'} in this window
        </p>

        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <Figure label="Active" value={health.active} />
          <Figure label="Idle" value={health.idle} />
          <Figure label="Asleep" value={health.asleep} />
          <Figure label="Duplicates" value={health.duplicateCount} />
        </dl>

        {/* Two claims, never one number. See `memoryCaption`. */}
        <p className="mt-2.5 text-xs text-[var(--color-text-muted)]">{memoryCaption(health)}</p>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {health.sleepableIds.length > 0 && (
            <Action
              label={`Hibernate ${health.sleepableIds.length} safe ${
                health.sleepableIds.length === 1 ? 'tab' : 'tabs'
              }`}
              primary
              onClick={() => hibernate(health.sleepableIds, 'tabs')}
            />
          )}
          {health.duplicateCount > 0 && (
            <Action
              label="Review duplicates"
              onClick={() => setReviewing(reviewing === 'duplicates' ? null : 'duplicates')}
            />
          )}
          {health.sleepableIds.length > 0 && (
            <Action
              label="Review idle tabs"
              onClick={() => setReviewing(reviewing === 'idle' ? null : 'idle')}
            />
          )}
          {heavy.length > 0 && (
            <Action
              label="Review memory-heavy tabs"
              onClick={() => setReviewing(reviewing === 'heavy' ? null : 'heavy')}
            />
          )}
        </div>

        {health.blockedCount > 0 && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {health.blockedCount} {health.blockedCount === 1 ? 'tab is' : 'tabs are'} being kept
            awake — playing audio, downloading, holding typed text, or marked Never Sleep. The list
            below says which, for each.
          </p>
        )}
      </div>

      {reviewing === 'duplicates' && (
        <div className="mt-2 space-y-2">
          {duplicateGroups.map((group) => (
            <div
              key={group.key}
              className="rounded-lg border border-[var(--color-border-subtle)] p-2.5"
            >
              <p className="text-xs font-medium">
                {group.tabs.length} tabs · {DUPLICATE_REASON_LABEL[group.reason]}
              </p>
              <ul className="mt-1 space-y-0.5">
                {group.tabs.map((tab) => (
                  <li
                    key={tab.id}
                    className="flex items-baseline gap-2 text-xs text-[var(--color-text-muted)]"
                  >
                    <span className="min-w-0 flex-1 truncate" title={tab.url}>
                      {tab.title || hostOf(tab.url)}
                    </span>
                    <span className="shrink-0 text-[10px]">
                      {tab.id === group.keepId ? 'kept' : 'would close'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="flex flex-wrap gap-1.5">
            <Action label="Close duplicates, keep one each" onClick={closeDuplicates} />
            <Action label="Keep all" onClick={() => setReviewing(null)} />
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            A pinned or protected copy is never closed, and anything closed here comes back with
            Ctrl+Shift+T.
          </p>
        </div>
      )}

      {reviewing === 'idle' && (
        <ul className="mt-2 space-y-1">
          {health.sleepableIds.map((tabId) => (
            <li
              key={tabId}
              className="flex items-baseline gap-2 rounded-md border border-[var(--color-border-subtle)] p-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">{titleFor(tabId)}</span>
              <button
                type="button"
                onClick={() =>
                  void window.browser
                    .invoke('performance:setProtected', { tabId, isProtected: true })
                    .then(() => onNotice('Marked Never Sleep. It will stay awake until you undo it.'))
                }
                className="shrink-0 cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Protect
              </button>
              <button
                type="button"
                onClick={() => hibernate([tabId], 'tab')}
                className="shrink-0 cursor-default rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Hibernate
              </button>
            </li>
          ))}
        </ul>
      )}

      {reviewing === 'heavy' && (
        <ul className="mt-2 space-y-1">
          {heavy.map((metric) => (
            <li
              key={metric.tabId}
              className="flex items-baseline gap-2 rounded-md border border-[var(--color-border-subtle)] p-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">{titleFor(metric.tabId)}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                {formatBytes(metric.memoryBytes ?? 0)}
                {/* Site isolation shares renderers, so a shared figure is the
                    process total divided — an estimate, and it says so. */}
                {metric.sharedProcess && ` (${metric.tabsOnProcess} tabs share this process)`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Figure({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div>
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

function Action({
  label,
  onClick,
  primary
}: {
  label: string
  onClick: () => void
  primary?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? 'cursor-pointer rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-black transition hover:opacity-90'
          : 'cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
      }
    >
      {label}
    </button>
  )
}

/**
 * The engine tracks six states; the summary needs four.
 *
 * RECENT and BACKGROUND are both "awake and not being looked at", which is not
 * a health problem, and PROTECTED is a tab somebody said to leave alone. None
 * of those belongs in a count of what could be tidied.
 */
function healthStateOf(state: PerformanceSnapshot['tabs'][number]['state']): HealthState {
  if (state === 'HIBERNATED') return 'HIBERNATED'
  if (state === 'FROZEN') return 'FROZEN'
  if (state === 'IDLE') return 'IDLE'
  return 'ACTIVE'
}
