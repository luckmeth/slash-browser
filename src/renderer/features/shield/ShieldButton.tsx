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

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3 text-[11px] text-[var(--color-text-muted)]">
      <span>{label}</span>
      <span className="text-[var(--color-text-primary)]">{value}</span>
    </div>
  )
}
