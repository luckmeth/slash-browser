import { useBrowserStore } from '../../stores/browserStore'
import { Icon } from '../../components/Icon'

/**
 * Sites you have zoomed, and the level each is remembered at.
 *
 * Chromium keeps zoom per origin within a session, but that does not survive a
 * restart — so a site you have to enlarge on every visit had to be enlarged
 * again after every launch. Slash stores the level itself, which means it also
 * has to be possible to see and undo, or the browser has quietly accumulated
 * preferences the user cannot inspect.
 */
export function SiteZoomSection(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const siteZoom = settings?.siteZoom ?? {}
  const entries = Object.entries(siteZoom).sort(([a], [b]) => a.localeCompare(b))

  const update = (next: Record<string, number>): void => {
    void window.browser.invoke('settings:update', { siteZoom: next })
  }

  if (entries.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        No sites have a saved zoom yet. Zoom any page with Ctrl and + or −, and Slash will use that
        level the next time you visit — including after a restart.
      </p>
    )
  }

  return (
    <div>
      <ul className="flex flex-col gap-1">
        {entries.map(([host, level]) => (
          <li
            key={host}
            className="group flex items-center gap-2 rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-[13px]">{host}</span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">
              {percentFor(level)}%
            </span>
            <button
              type="button"
              aria-label={`Reset zoom for ${host}`}
              onClick={() => {
                const next = { ...siteZoom }
                delete next[host]
                update(next)
              }}
              className="shrink-0 cursor-default rounded p-1 text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:bg-white/15 focus:opacity-100"
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => update({})}
        className="mt-2 cursor-default rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs transition hover:bg-white/10"
      >
        Reset all to 100%
      </button>
    </div>
  )
}

/**
 * Chromium's zoom *level* to a percentage.
 *
 * Each level is a factor of 1.2, which is why the numbers people recognise —
 * 110%, 125%, 150% — are not evenly spaced. Rounded for display only; the
 * stored value stays the exact level so nothing is lost in the round trip.
 */
function percentFor(level: number): number {
  return Math.round(1.2 ** level * 100)
}
