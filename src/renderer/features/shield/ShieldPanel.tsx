import { useCallback, useEffect, useState } from 'react'
import type { BlockingStatus } from '@shared/types/blocking'
import { CHROME_HEIGHT } from '@shared/constants'

/**
 * The shield panel, rendered in the overlay view.
 *
 * It lived in the chrome document as a dropdown under the shield button, which
 * was the classic layering trap: a `WebContentsView` is a native layer
 * composited above the DOM, so the part of the dropdown overlapping the page
 * was simply invisible — users saw a sliver of panel wherever chrome happened
 * to show through (a side panel, the new tab page) and nothing anywhere else.
 * Anything that must draw over page content renders here instead.
 *
 * The panel is self-sufficient: the overlay document knows nothing about the
 * chrome's React state, so it asks which tab is active and loads that tab's
 * blocking status itself.
 *
 * Wording is careful. This blocks *requests* by domain and refuses *known-bad
 * domains* — it is not virus scanning, and a browser cannot do virus scanning.
 * A shield icon invites exactly that misreading, so the panel says plainly what
 * it does and does not do.
 */
export function ShieldPanel(): React.JSX.Element {
  const [tabId, setTabId] = useState<string | null>(null)
  const [status, setStatus] = useState<BlockingStatus | null>(null)

  const close = useCallback((): void => {
    void window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }, [])

  useEffect(() => {
    void window.browser.invoke('tabs:list', undefined).then((result) => {
      if (result.ok && result.value.activeTabId) setTabId(result.value.activeTabId)
      // No active tab means nothing to describe — an empty panel would be
      // an invisible modal overlay eating clicks.
      else close()
    })
  }, [close])

  useEffect(() => {
    if (!tabId) return
    const load = (): void => {
      void window.browser.invoke('blocking:status', { tabId }).then((result) => {
        if (result.ok) setStatus(result.value)
        else close()
      })
    }
    load()
    // Counts climb as sub-resources load, so poll briefly while the panel is
    // open rather than showing a number that is stale the moment it appears.
    const timer = setInterval(load, 1200)
    return () => clearInterval(timer)
  }, [tabId, close])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const off = status ? status.siteAllowed || !status.adsEnabled : false
  const count = status?.blockedOnPage ?? 0

  return (
    // Backdrop first: the overlay is modal and swallows every click in its
    // bounds, so an unpainted region must still mean "dismiss", never "dead".
    <div className="fixed inset-0" onClick={close}>
      {status && (
        <div
          className="glass-float animate-rise absolute right-3 w-72 rounded-xl p-3"
          style={{ top: CHROME_HEIGHT + 6 }}
          onClick={(event) => event.stopPropagation()}
        >
          <p className="text-sm font-medium">
            {off ? 'Blocking is off for this site' : `${count} blocked on this page`}
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Advertising and tracking requests are cancelled before they leave your machine, so they
            cost you no bandwidth or time.
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
                void window.browser.invoke('shield:setSiteLock', { tabId, locked }).then((result) => {
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
                    void window.browser.invoke('shield:clearActivity', { tabId }).then((result) => {
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
            <Row label="Known-bad site rules" value={status.maliciousRuleCount.toLocaleString()} />
          </div>

          {/* The honesty note. A shield icon implies more than this does. */}
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            This blocks requests by domain and refuses known-bad sites. It is <strong>not</strong> a
            virus scanner — a browser cannot inspect files for malware. Keep Windows Security on for
            that.
          </p>
          {/* Said here rather than left to be discovered, because this is the
              one people notice and the shield count looks like a promise. */}
          {status.host.endsWith('youtube.com') && (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              On YouTube, Slash removes the ad breaks from the player's data before the video
              plays. If an ad still appears, YouTube delivered it{' '}
              <strong>inside the video stream itself</strong>, which no browser can remove.
            </p>
          )}
        </div>
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
