import { useEffect, useState } from 'react'
import type { PerformanceSnapshot } from '@shared/types/performance'
import type { ShieldCounts } from '@shared/types/blocking'
import type { Snapshot } from '@shared/types/snapshot'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * What Slash has actually done for you, on the screen you see most.
 *
 * The new tab page previously showed a logo, a search box and a grid of
 * frequently-visited sites — which is to say, nothing any other browser does not.
 * Every genuinely distinctive thing this browser does was behind a panel you had
 * to already know about. A capability the user cannot see is, from their side,
 * indistinguishable from one that does not exist.
 *
 * Every number here comes from a real recorded decision or measurement. Nothing
 * is projected, and a section with nothing to report renders nothing rather than
 * a zero — an empty statistic is worse than silence, because it invites the
 * reader to conclude the feature does not work.
 */
/**
 * Assumed size of a request that never happened.
 *
 * A blocked request is cancelled before any response arrives, so its real size
 * is unknowable — there is no header to read. This is therefore an **estimate**
 * and every place it is shown says so, which is the same rule that keeps
 * freezing a tab from quoting a byte figure while hibernation may.
 *
 * 45 KB is a deliberately conservative figure for a typical ad or tracker
 * payload; overstating it would make the number flattering rather than true.
 */
const AVERAGE_BLOCKED_BYTES = 45 * 1024

export function SlashSummary(): React.JSX.Element | null {
  const [performance, setPerformance] = useState<PerformanceSnapshot | null>(null)
  const [restorePoints, setRestorePoints] = useState<Snapshot[]>([])
  const [blocked, setBlocked] = useState<ShieldCounts | null>(null)
  const workspaces = useBrowserStore((s) => s.workspaces)
  const activeWorkspaceId = useBrowserStore((s) => s.activeWorkspaceId)
  const tabs = useBrowserStore((s) => s.tabs)
  const togglePanel = useBrowserStore((s) => s.togglePanel)

  useEffect(() => {
    return window.browser.on('performance:changed', setPerformance)
  }, [])

  useEffect(() => {
    void window.browser.invoke('snapshots:list', undefined).then((result) => {
      if (result.ok) setRestorePoints(result.value.slice(0, 3))
    })
  }, [])

  // Polled rather than pushed: the figure climbs constantly while pages load,
  // and an event per blocked request would be thousands of IPC messages to
  // animate a number nobody is watching that closely.
  useEffect(() => {
    const load = (): void => {
      void window.browser.invoke('blocking:sessionTotals', undefined).then((result) => {
        if (result.ok) setBlocked(result.value)
      })
    }
    load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])

  const asleep = performance?.tabs.filter((tab) => tab.state === 'HIBERNATED').length ?? 0
  const savedBytes = performance?.totalMeasuredSavingsBytes ?? 0
  const blockedTotal = blocked
    ? blocked.ads + blocked.trackers + blocked.popups + blocked.redirects
    : 0

  return (
    <section className="animate-rise mt-10 w-full">
      <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-4">
        {/*
          Tab sleeping. The one thing here that Chrome and Brave do not do, and
          the figure is measured — the working set read immediately before each
          renderer was destroyed, not an estimate of what freezing might save.
        */}
        <Card
          icon="moon"
          label="Tabs asleep"
          value={asleep > 0 ? String(asleep) : '—'}
          detail={
            asleep > 0
              ? `${formatBytes(savedBytes)} freed, measured`
              : 'Idle tabs sleep automatically'
          }
          onClick={() => togglePanel('performance')}
        />

        {/* Workspaces are managed from the rail on the left, so this card
            reports rather than navigating somewhere that does not exist. */}
        <Card
          icon="wsFolder"
          label="Workspaces"
          value={String(workspaces.length)}
          detail={`${tabs.length} tab${tabs.length === 1 ? '' : 's'} in ${
            workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? 'this workspace'
          }`}
        />

        {/*
          Blocked requests. Scoped to this session and labelled so — an all-time
          figure would mean storing a running count of what the user browsed,
          which is not a trade worth making for a statistic.
        */}
        <Card
          icon="shield"
          label="Blocked"
          value={blockedTotal > 0 ? blockedTotal.toLocaleString() : '—'}
          detail={
            blockedTotal > 0
              ? `~${formatBytes(blockedTotal * AVERAGE_BLOCKED_BYTES)} not downloaded, estimated`
              : 'Ads and trackers, before they load'
          }
        />

        <Card
          icon="clock"
          label="Restore points"
          value={String(restorePoints.length)}
          detail={
            restorePoints.length > 0
              ? 'Reopen an earlier session'
              : 'Saved automatically as you browse'
          }
          onClick={() => togglePanel('timemachine')}
        />
      </div>

      {restorePoints.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-[11px] font-medium tracking-[0.12em] text-[var(--color-text-muted)] uppercase">
            Pick up where you left off
          </h2>
          <div className="flex flex-col gap-1.5">
            {restorePoints.map((point) => (
              <button
                key={point.id}
                type="button"
                onClick={() => togglePanel('timemachine')}
                className="glass-raised flex cursor-default items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-[var(--glass-high)]"
              >
                <Icon name="clock" size={14} className="shrink-0 text-[var(--color-accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{point.label}</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">
                    {point.tabCount} tab{point.tabCount === 1 ? '' : 's'}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {/*
            Said plainly, because the alternative is a user discovering it at the
            worst moment — restoring a session and finding themselves signed out.
          */}
          <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            Restore points bring back pages and history. Whether you stay signed in depends on the
            site&apos;s own cookies.
          </p>
        </div>
      )}
    </section>
  )
}

function Card({
  icon,
  label,
  value,
  detail,
  onClick
}: {
  icon: string
  label: string
  value: string
  detail: string
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="glass-raised flex cursor-default flex-col gap-1 rounded-xl p-3.5 text-left transition hover:-translate-y-0.5 hover:bg-[var(--glass-high)]"
    >
      <span className="flex items-center gap-1.5 text-[11px] tracking-[0.08em] text-[var(--color-text-muted)] uppercase">
        <Icon name={icon as never} size={12} />
        {label}
      </span>
      <span className="font-mono text-2xl leading-tight">{value}</span>
      <span className="text-[11px] text-[var(--color-text-muted)]">{detail}</span>
    </button>
  )
}

/** Binary units, matching what Task Manager reports, so the two agree. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
