import { useEffect, useState } from 'react'
import {
  SLEEP_BLOCKER_LABELS,
  type PerformanceSnapshot,
  type PerformanceState,
  type TabMetrics
} from '@shared/types/performance'
import { hostOf } from '@shared/url'
import { isInternalUrl } from '@shared/types/tab'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

const STATE_STYLES: Record<PerformanceState, string> = {
  ACTIVE: 'text-[var(--color-good)]',
  RECENT: 'text-[var(--color-text-primary)]',
  BACKGROUND: 'text-[var(--color-text-muted)]',
  IDLE: 'text-amber-400',
  FROZEN: 'text-sky-400',
  HIBERNATED: 'text-violet-400',
  PROTECTED: 'text-[var(--color-accent)]'
}

/**
 * The performance dashboard.
 *
 * A route the user opens, never permanent chrome — the product rule is that
 * advanced capability must not complicate the default interface.
 */
export function PerformancePanel(): React.JSX.Element {
  const tabs = useBrowserStore((s) => s.tabs)
  const settings = useBrowserStore((s) => s.settings)
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const result = await window.browser.invoke('performance:snapshot', undefined)
      if (result.ok) setSnapshot(result.value)
    }
    void load()
    return window.browser.on('performance:changed', (next) => setSnapshot(next))
  }, [])

  if (!snapshot) {
    return <p className="p-4 text-sm text-[var(--color-text-muted)]">Measuring…</p>
  }

  const titleFor = (tabId: string): string => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return 'Tab in another workspace'
    if (isInternalUrl(tab.url)) return 'New tab'
    return tab.title || hostOf(tab.url)
  }

  return (
    <div className="space-y-5 p-4">
      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
          Mode
        </h3>
        <div className="flex gap-1 rounded-lg border border-[var(--color-border-subtle)] p-1">
          {(['off', 'balanced', 'aggressive'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => void window.browser.invoke('performance:setMode', { mode })}
              className={`flex-1 cursor-pointer rounded-md px-2 py-1 text-xs capitalize transition ${
                settings?.performanceMode === mode
                  ? 'bg-[var(--color-accent)] font-medium text-black'
                  : 'text-[var(--color-text-muted)] hover:bg-white/5'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
          {settings?.performanceMode === 'off'
            ? 'Nothing sleeps automatically. Suggestions below still appear, and you apply them.'
            : settings?.performanceMode === 'aggressive'
              ? 'Tabs freeze after 6 minutes idle and hibernate after 30.'
              : 'Tabs freeze after 20 minutes idle and hibernate after 2 hours.'}
        </p>
      </section>

      {snapshot.totalMeasuredSavingsBytes > 0 && (
        <section className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-sm">
            <strong>{formatBytes(snapshot.totalMeasuredSavingsBytes)}</strong> freed by hibernated
            tabs
          </p>
          {/* Measured, not projected: recorded from the real working set at the
              moment each renderer was destroyed. */}
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            Measured at the moment each tab was hibernated.
          </p>
        </section>
      )}

      {!snapshot.metricsAvailable && (
        <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-3 text-xs text-[var(--color-text-muted)]">
          Per-process measurements are unavailable on this system. States and idle times below are
          still accurate; CPU and memory columns are not shown.
        </p>
      )}

      {snapshot.recommendations.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
            Suggestions
          </h3>
          <div className="space-y-2">
            {snapshot.recommendations.map((rec) => (
              <div
                key={rec.id}
                className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3"
              >
                <p className="text-sm font-medium">{rec.title}</p>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{rec.detail}</p>
                {rec.tabIds.length > 0 && (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        void window.browser
                          .invoke('performance:applyRecommendation', { tabIds: rec.tabIds })
                          .then((result) => {
                            if (result.ok) {
                              setNotice(
                                `Hibernated ${result.value.applied} of ${rec.tabIds.length} tabs.` +
                                  (result.value.applied < rec.tabIds.length
                                    ? ' The rest became unsafe to sleep in the meantime.'
                                    : '')
                              )
                            }
                          })
                      }}
                      className="cursor-pointer rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-black transition hover:opacity-90"
                    >
                      Apply
                    </button>
                    {rec.estimatedSavingsBytes > 0 && (
                      // Always labelled: this is projected from tabs that are
                      // still running, never a measurement.
                      <span className="text-xs text-[var(--color-text-muted)]">
                        ~{formatBytes(rec.estimatedSavingsBytes)} estimated
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {notice && (
        <p className="rounded-lg border border-[var(--color-border-subtle)] p-2 text-xs text-[var(--color-text-muted)]">
          {notice}
        </p>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
          Tabs in this window
        </h3>
        <ul className="space-y-1">
          {snapshot.tabs
            .filter((metric) => tabs.some((t) => t.id === metric.tabId))
            .map((metric) => (
              <TabRow key={metric.tabId} metric={metric} title={titleFor(metric.tabId)} />
            ))}
        </ul>
      </section>
    </div>
  )
}

function TabRow({ metric, title }: { metric: TabMetrics; title: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const tab = useBrowserStore((s) => s.tabs.find((t) => t.id === metric.tabId))

  return (
    <li className="rounded-md border border-[var(--color-border-subtle)] p-2">
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="block truncate text-sm">{title}</span>
          <span className={`text-xs ${STATE_STYLES[metric.state]}`}>
            {metric.state.toLowerCase()}
            {metric.idleMs > 60_000 && metric.state !== 'ACTIVE' && (
              <span className="text-[var(--color-text-muted)]">
                {' '}
                · idle {formatDuration(metric.idleMs)}
              </span>
            )}
          </span>
        </button>

        <div className="shrink-0 text-right">
          {metric.memoryBytes !== null && (
            <span className="block font-mono text-xs">{formatBytes(metric.memoryBytes)}</span>
          )}
          {metric.sharedProcess && (
            // The single most important honesty label in this panel: Chromium
            // reports per process, and this process serves several tabs.
            <span
              className="text-[10px] text-amber-400"
              title={`This renderer process is shared by ${metric.tabsOnProcess} tabs. The figure is the process total divided between them, not a measurement of this tab alone.`}
            >
              shared ÷{metric.tabsOnProcess} — estimate
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-[var(--color-border-subtle)] pt-2">
          {metric.cpuPercent !== null && (
            <p className="text-xs text-[var(--color-text-muted)]">
              CPU {metric.cpuPercent.toFixed(1)}%
              {metric.processId !== null && ` · pid ${metric.processId}`}
            </p>
          )}

          {metric.blockers.length > 0 && (
            <div>
              <p className="text-xs font-medium">Cannot sleep because:</p>
              <ul className="mt-0.5 space-y-0.5">
                {metric.blockers.map((blocker) => (
                  <li key={blocker} className="text-xs text-[var(--color-text-muted)]">
                    • {SLEEP_BLOCKER_LABELS[blocker]}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2 text-xs">
            <Action
              label={tab?.isProtected ? 'Allow sleeping' : 'Never sleep'}
              onClick={() =>
                void window.browser.invoke('performance:setProtected', {
                  tabId: metric.tabId,
                  isProtected: !tab?.isProtected
                })
              }
            />
            {metric.state === 'HIBERNATED' ? (
              <Action
                label="Wake"
                onClick={() =>
                  void window.browser.invoke('performance:restore', { tabId: metric.tabId })
                }
              />
            ) : (
              metric.blockers.length === 0 && (
                <Action
                  label="Hibernate now"
                  onClick={() =>
                    void window.browser.invoke('performance:hibernate', { tabId: metric.tabId })
                  }
                />
              )
            )}
          </div>

          {metric.measuredSavingsBytes !== null && (
            <p className="text-xs text-[var(--color-good)]">
              Freed {formatBytes(metric.measuredSavingsBytes)} — measured
            </p>
          )}
        </div>
      )}
    </li>
  )
}

function Action({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1 rounded border border-[var(--color-border-subtle)] px-2 py-0.5 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      <Icon name="settings" size={10} />
      {label}
    </button>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}
