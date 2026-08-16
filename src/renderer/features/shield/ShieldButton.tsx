import { useEffect, useState } from 'react'
import type { BlockingStatus } from '@shared/types/blocking'
import { isInternalUrl } from '@shared/types/tab'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * The shield: how many requests were blocked on this page, and the per-site
 * switch.
 *
 * Wording is careful. This blocks *requests* by domain and refuses *known-bad
 * domains* — it is not virus scanning, and a browser cannot do virus scanning.
 * A shield icon invites exactly that misreading, so the panel says plainly what
 * it does and does not do.
 */
export function ShieldButton(): React.JSX.Element | null {
  const activeTab = useBrowserStore((s) => s.activeTab())
  const [status, setStatus] = useState<BlockingStatus | null>(null)
  const [open, setOpen] = useState(false)

  const tabId = activeTab?.id ?? null
  const url = activeTab?.url ?? ''

  useEffect(() => {
    if (!tabId || isInternalUrl(url)) {
      setStatus(null)
      return
    }
    const load = (): void => {
      void window.browser.invoke('blocking:status', { tabId }).then((result) => {
        if (result.ok) setStatus(result.value)
      })
    }
    load()
    // Counts climb as sub-resources load, so poll briefly while the page settles
    // rather than showing a number that is stale the moment it appears.
    const timer = setInterval(load, 1200)
    return () => clearInterval(timer)
  }, [tabId, url, activeTab?.isLoading])

  if (!status || isInternalUrl(url)) return null

  const off = status.siteAllowed || !status.adsEnabled
  const count = status.blockedOnPage

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Content blocking — ${count} requests blocked on this page`}
        title={`${count} blocked on this page`}
        className={`flex cursor-default items-center gap-1 rounded-lg px-1.5 py-1 transition hover:bg-white/10 ${
          off ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-good)]'
        }`}
      >
        <Icon name={off ? 'shieldOff' : 'shield'} size={14} />
        {!off && count > 0 && <span className="font-mono text-[10px]">{count}</span>}
      </button>

      {open && (
        <>
          {/* Click-away. The dropdown sits inside the chrome document, above the
              toolbar row, so it does not need the overlay view. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="glass-float animate-rise absolute right-0 z-20 mt-2 w-72 rounded-xl p-3">
            <p className="text-sm font-medium">
              {off ? 'Blocking is off for this site' : `${count} blocked on this page`}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Advertising and tracking requests are cancelled before they leave your machine, so
              they cost you no bandwidth or time.
            </p>

            <label className="mt-3 flex cursor-default items-center justify-between gap-2 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2">
              <span className="min-w-0 text-xs">
                Block on <span className="font-medium">{status.host}</span>
              </span>
              <input
                type="checkbox"
                checked={!status.siteAllowed}
                onChange={(event) => {
                  if (!tabId) return
                  void window.browser
                    .invoke('blocking:setSiteAllowed', {
                      host: status.host,
                      allowed: !event.target.checked,
                      tabId
                    })
                    .then((result) => {
                      if (result.ok) setStatus(result.value)
                      setOpen(false)
                    })
                }}
              />
            </label>

            {/* What was blocked, split by category. These are the recorded
                decisions themselves, so they always sum to the total. */}
            {count > 0 && (
              <div className="mt-3 grid grid-cols-4 gap-1 border-t border-[var(--glass-edge)] pt-3">
                <Stat label="Ads" value={status.counts.ads} />
                <Stat label="Trackers" value={status.counts.trackers} />
                <Stat label="Popups" value={status.counts.popups} />
                <Stat label="Redirects" value={status.counts.redirects} />
              </div>
            )}

            <div className="mt-3 space-y-2 border-t border-[var(--glass-edge)] pt-3">
              <Toggle
                label="Stay on this site"
                hint="Blocks popups and automatic jumps to other sites. You can always click through."
                checked={status.siteLocked}
                onChange={(locked) => {
                  if (!tabId) return
                  void window.browser
                    .invoke('shield:setSiteLock', { tabId, locked })
                    .then((result) => {
                      if (result.ok) setStatus(result.value)
                    })
                }}
              />
              <Toggle
                label="Strict mode"
                hint="Also stops unclicked windows and jumps to other sites. More false positives."
                checked={status.strictMode}
                onChange={(strict) => {
                  if (!tabId) return
                  void window.browser
                    .invoke('shield:setMode', { mode: strict ? 'strict' : 'standard', tabId })
                    .then((result) => {
                      if (result.ok) setStatus(result.value)
                    })
                }}
              />
            </div>

            {status.recent.length > 0 && (
              <div className="mt-3 border-t border-[var(--glass-edge)] pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium">Recent</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!tabId) return
                      void window.browser
                        .invoke('shield:clearActivity', { tabId })
                        .then((result) => {
                          if (result.ok) setStatus(result.value)
                        })
                    }}
                    className="cursor-default text-[11px] text-[var(--color-text-muted)] transition hover:text-[var(--color-text-primary)]"
                  >
                    Clear
                  </button>
                </div>
                {/* Hosts, not URLs — a blocked request's path and query can
                    carry identifiers and search terms. */}
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                  {status.recent.slice(0, 8).map((entry) => (
                    <li
                      key={entry.id}
                      className="flex justify-between gap-2 text-[11px] text-[var(--color-text-muted)]"
                    >
                      <span className="truncate" title={entry.host}>
                        {entry.host}
                      </span>
                      <span className="shrink-0 opacity-60">{entry.category}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-3 space-y-1 border-t border-[var(--glass-edge)] pt-2">
              <Row label="Ad and tracker rules" value={status.ruleCount.toLocaleString()} />
              <Row
                label="Known-bad site rules"
                value={status.maliciousRuleCount.toLocaleString()}
              />
            </div>

            {/* The honesty note. A shield icon implies more than this does. */}
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              This blocks requests by domain and refuses known-bad sites. It is{' '}
              <strong>not</strong> a virus scanner — a browser cannot inspect files for malware.
              Keep Windows Security on for that.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-lg bg-white/5 px-1.5 py-1.5 text-center">
      <div className="font-mono text-sm text-[var(--color-text-primary)]">{value}</div>
      <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex cursor-default items-start justify-between gap-2 rounded-lg border border-[var(--glass-edge)] px-2.5 py-2">
      <span className="min-w-0">
        <span className="block text-xs">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-text-muted)]">
          {hint}
        </span>
      </span>
      <input
        type="checkbox"
        className="mt-0.5 shrink-0"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3 text-[11px] text-[var(--color-text-muted)]">
      <span>{label}</span>
      <span className="text-[var(--color-text-primary)]">{value}</span>
    </div>
  )
}
