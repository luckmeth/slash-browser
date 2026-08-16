import { useEffect, useState } from 'react'
import type { PerformanceSnapshot } from '@shared/types/performance'
import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * How much memory tab sleeping is saving you, in the toolbar.
 *
 * This is the one thing Slash does that Chrome and Brave do not, and until now
 * it happened entirely in silence — the engine hibernated tabs, freed real
 * memory, and told nobody. A capability the user cannot see is, from their side,
 * indistinguishable from one that does not exist.
 *
 * The number shown is **measured**, not projected: `totalMeasuredSavingsBytes`
 * is the sum of working-set readings taken immediately before each renderer was
 * destroyed. Frozen tabs save CPU and are counted separately in the panel, but
 * they are never given a byte figure here — quoting an estimate beside a
 * measured number would make both look like guesses.
 */
export function SleepIndicator(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null)
  const togglePanel = useBrowserStore((s) => s.togglePanel)

  useEffect(() => {
    return window.browser.on('performance:changed', setSnapshot)
  }, [])

  if (!snapshot) return null

  const asleep = snapshot.tabs.filter((tab) => tab.state === 'HIBERNATED').length
  // Nothing asleep means nothing to report. A permanent "0 asleep" would be
  // chrome that earns no space — the dashboard is there for the full picture.
  if (asleep === 0) return null

  const saved = formatBytes(snapshot.totalMeasuredSavingsBytes)

  return (
    <button
      type="button"
      onClick={() => togglePanel('performance')}
      title={`${asleep} tab${asleep === 1 ? '' : 's'} asleep, freeing ${saved} of measured memory. Click for details.`}
      aria-label={`${asleep} tabs asleep, ${saved} freed`}
      className="flex shrink-0 cursor-default items-center gap-1.5 rounded-lg px-1.5 py-1 text-[var(--color-good)] transition hover:bg-white/10"
    >
      <Icon name="moon" size={14} />
      <span className="font-mono text-[10px] leading-none">
        {asleep}
        {snapshot.totalMeasuredSavingsBytes > 0 && (
          <span className="ml-1 opacity-70">{saved}</span>
        )}
      </span>
    </button>
  )
}

/**
 * Bytes as a person reads them.
 *
 * Binary units, because that is what Task Manager shows and a user comparing
 * the two should see the same figure rather than a 7% discrepancy they have to
 * explain to themselves.
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
