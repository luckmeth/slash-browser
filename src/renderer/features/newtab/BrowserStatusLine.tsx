import { useEffect, useMemo, useState } from 'react'
import { localDay, type ProtectionDay } from '@shared/protectionReport'
import { findDuplicateGroups, duplicateCloseIds } from '@shared/tabDuplicates'
import { isInternalUrl } from '@shared/types/tab'
import { useBrowserStore } from '../../stores/browserStore'

/**
 * One line about the browser itself, under the greeting.
 *
 * Deliberately a line and not a dashboard. CLAUDE.md records that a block of
 * counters used to sit on this page and was removed, because "15 blocked, 3
 * restore points" is a dashboard and a new tab is a place you pass through. The
 * numbers are worth having back; the block is not — so this is one sentence,
 * each part a link to the panel that owns it, and it disappears entirely when
 * there is nothing to say.
 *
 * Every figure is real. Tabs and duplicates are counted from the live tab list
 * with the same rule Tab Health uses; the blocked count is today's row from the
 * protection ledger, which counts requests the shield actually cancelled. There
 * is no estimate here and nothing is projected.
 */
export function BrowserStatusLine(): React.JSX.Element | null {
  const tabs = useBrowserStore((s) => s.tabs)
  const [days, setDays] = useState<ProtectionDay[]>([])

  useEffect(() => {
    void window.browser.invoke('protection:week', undefined).then((result) => {
      if (result.ok) setDays(result.value.days)
    })
  }, [])

  const openTabs = useMemo(() => tabs.filter((tab) => !isInternalUrl(tab.url)), [tabs])

  const duplicates = useMemo(
    () =>
      duplicateCloseIds(
        findDuplicateGroups(
          openTabs.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            lastActiveAt: tab.lastActiveAt,
            isPinned: tab.isPinned,
            isProtected: tab.isProtected
          }))
        )
      ).length,
    [openTabs]
  )

  // Today's row, not the week's: "blocked today" is a claim about today, and
  // quietly showing a week's total under that label would be a lie by caption.
  const blockedToday = useMemo(() => {
    const today = days.find((day) => day.day === localDay(Date.now()))
    if (!today) return 0
    // Requests the shield actually cancelled. Redirects are excluded: a
    // redirect stopped is not a request blocked, and adding them would inflate
    // a number somebody reads as "things that did not reach me".
    return today.ads + today.trackers + today.popups
  }, [days])

  const parts: { key: string; text: string; command: 'open-performance' | 'open-protection' }[] = []

  // The tab count is deliberately absent: the greeting above already says
  // "Personal · 17 tabs", and repeating it here would be the noise that got the
  // old counter block removed from this page in the first place.
  if (duplicates > 0) {
    parts.push({
      key: 'duplicates',
      text: `${duplicates} duplicate ${duplicates === 1 ? 'tab' : 'tabs'}`,
      command: 'open-performance'
    })
  }
  if (blockedToday > 0) {
    parts.push({
      key: 'blocked',
      text: `${blockedToday.toLocaleString()} blocked today`,
      command: 'open-protection'
    })
  }

  if (parts.length === 0) return null

  return (
    <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-1.5 text-[11px] text-[var(--color-text-muted)]">
      {parts.map((part, index) => (
        <span key={part.key} className="flex items-center gap-1.5">
          {index > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            onClick={() => void window.browser.invoke('ui:run', { command: part.command })}
            className="cursor-default underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-text-primary)]"
          >
            {part.text}
          </button>
        </span>
      ))}
    </p>
  )
}
