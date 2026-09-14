import { useEffect, useMemo, useState } from 'react'
import type { InvokeResponse } from '@shared/ipc/contracts'
import { buildTrustReport, trustSummary, type TrustTone } from '@shared/siteTrust'
import { hostOf } from '@shared/url'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon, type IconName } from '../../components/Icon'

type Signals = InvokeResponse<'trust:report'>

const TONE_STYLES: Record<TrustTone, string> = {
  good: 'text-[var(--color-good)]',
  neutral: 'text-[var(--color-text-muted)]',
  caution: 'text-[var(--color-warn)]'
}

const TONE_ICONS: Record<TrustTone, IconName> = {
  good: 'shield',
  neutral: 'eye',
  caution: 'warning'
}

/**
 * Site Trust: what the browser knows about this site, and how it knows it.
 *
 * Every row is a fact with the sentence explaining it. There is deliberately no
 * score — see `siteTrust.ts` for why a number out of ten would be an opinion
 * presented as a measurement, and a promise of safety nothing here can make.
 *
 * It unifies rather than duplicates: the shield, Redirect X-Ray, the permission
 * store and the download list each still own their own detail, and the rows
 * that concern them link there rather than reimplementing what they show.
 */
export function SiteTrustPanel(): React.JSX.Element {
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const tabs = useBrowserStore((s) => s.tabs)
  const [signals, setSignals] = useState<Signals | null>(null)
  const [loaded, setLoaded] = useState(false)

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null

  useEffect(() => {
    if (!activeTabId) {
      setSignals(null)
      setLoaded(true)
      return
    }
    setLoaded(false)
    void window.browser.invoke('trust:report', { tabId: activeTabId }).then((result) => {
      setSignals(result.ok ? result.value : null)
      setLoaded(true)
    })
    // Re-read when the tab navigates: every signal here is about one page, and
    // a report left over from the previous address is worse than none.
  }, [activeTabId, activeTab?.url])

  const rows = useMemo(() => (signals ? buildTrustReport(signals) : []), [signals])

  if (!loaded) return <p className="p-4 text-sm text-[var(--color-text-muted)]">Reading…</p>

  if (!signals) {
    return (
      <p className="p-4 text-sm text-[var(--color-text-muted)]">
        Open a page to see what Slash knows about it.
      </p>
    )
  }

  const host = hostOf(signals.url)

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="truncate text-sm font-semibold" title={signals.url}>
          {host || 'This page'}
        </h3>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{trustSummary(rows)}</p>
      </div>

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3"
          >
            <p className="flex items-baseline gap-2">
              <Icon
                name={TONE_ICONS[row.tone]}
                size={13}
                className={`shrink-0 ${TONE_STYLES[row.tone]}`}
              />
              <span className="text-xs text-[var(--color-text-muted)]">{row.label}</span>
              <span className={`ml-auto shrink-0 text-xs font-medium ${TONE_STYLES[row.tone]}`}>
                {row.value}
              </span>
            </p>
            {/* The explanation is the point of the row, not a tooltip on it. */}
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{row.explanation}</p>
            {DETAIL_PANEL[row.id] && (
              <button
                type="button"
                onClick={() =>
                  void window.browser.invoke('ui:run', { command: DETAIL_PANEL[row.id]! })
                }
                className="mt-1.5 cursor-default text-xs underline decoration-dotted underline-offset-2 hover:text-[var(--color-text-primary)]"
              >
                {DETAIL_LABEL[row.id]}
              </button>
            )}
          </li>
        ))}
      </ul>

      <p className="text-xs text-[var(--color-text-muted)]">
        This is what Slash can see from here. It is not a judgement about the site, and no signal
        above can tell you whether the people behind it are honest.
      </p>
    </div>
  )
}

/**
 * Which panel owns the detail behind each row.
 *
 * The point of unifying is that the engines keep their own screens — this one
 * summarises and hands over rather than growing a second copy of the redirect
 * chain or the permission list.
 */
const DETAIL_PANEL: Record<string, 'open-redirects' | 'open-permissions' | 'open-downloads'> = {
  redirects: 'open-redirects',
  permissions: 'open-permissions',
  denied: 'open-permissions',
  downloads: 'open-downloads'
}

const DETAIL_LABEL: Record<string, string> = {
  redirects: 'See the chain in Redirect X-Ray',
  permissions: 'Review or withdraw in Permissions',
  denied: 'See the permission log',
  downloads: 'Open downloads'
}
