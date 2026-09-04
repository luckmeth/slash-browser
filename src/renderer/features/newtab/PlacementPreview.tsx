/**
 * A miniature Slash window showing where one placement actually lands.
 *
 * Written because a price list is not a thing anybody can evaluate. "Side card,
 * $2.50/hour" tells a company nothing about whether it is a banner across the
 * page or a strip in the margin, and the difference is the entire purchase.
 * These are drawn to the same proportions as the real chrome — the centred
 * content column, the gutters either side, the toolbar rows — so the mock reads
 * as the browser rather than as a diagram.
 *
 * Everything is layout: no images, no canvas, nothing fetched. The advert's
 * region pulses so the eye lands on it, and that pulse is the one animation
 * here that repeats — justified because this page exists to draw attention to
 * exactly that rectangle, and it stops the moment the page is closed.
 */
export function PlacementPreview({ placement }: { placement: string }): React.JSX.Element {
  const lit = 'bg-[var(--color-accent)] slash-ad-pulse'
  const dim = 'bg-white/12'

  return (
    <div
      aria-hidden="true"
      className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-white/10 bg-[#0d1017]"
    >
      {/* The takeover replaces the whole backdrop, so it sits under the chrome. */}
      {placement === 'background' && (
        <div className={`absolute inset-x-0 top-[18%] bottom-0 ${lit} opacity-70`} />
      )}

      {/* Chrome: workspace row, tabs, address bar. */}
      <div className="relative flex h-[18%] flex-col justify-center gap-[3px] border-b border-white/10 bg-white/[0.05] px-2">
        <div className="flex gap-1">
          <span className="h-[3px] w-5 rounded-full bg-white/25" />
          <span className="h-[3px] w-4 rounded-full bg-white/12" />
          <span className="h-[3px] w-4 rounded-full bg-white/12" />
        </div>
        <div className="h-[5px] w-full rounded-full bg-white/10" />
      </div>

      {/* The page area, with the centred column and its gutters. */}
      <div className="relative flex h-[82%] justify-center gap-[6px] px-2 pt-2">
        {/* Left gutter */}
        <div className="flex w-[18%] flex-col pt-1">
          {placement === 'rail' && <div className={`h-[38%] w-full rounded ${lit}`} />}
        </div>

        {/* Content column */}
        <div className="flex w-[52%] flex-col items-center gap-[5px]">
          <span className="mt-1 h-[6px] w-[38%] rounded-full bg-white/20" />
          <span className="h-[8px] w-full rounded-full bg-white/10" />

          {/* Shortcut grid, with one tile lit for the tile placement. */}
          <div className="mt-1 grid w-full grid-cols-4 gap-[3px]">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((cell) => (
              <span
                key={cell}
                className={`h-[9px] rounded-[2px] ${placement === 'tile' && cell === 1 ? lit : dim}`}
              />
            ))}
          </div>

          {placement === 'banner' && <div className={`mt-1 h-[16%] w-full rounded ${lit}`} />}
        </div>

        {/* Right gutter */}
        <div className="flex w-[18%] flex-col pt-1">
          {placement === 'rail' && <div className={`h-[38%] w-full rounded ${lit}`} />}
        </div>

        {/* The notice floats over the page rather than sitting in the column. */}
        {placement === 'notice' && (
          <div
            className={`absolute bottom-2 left-1/2 h-[15%] w-[62%] -translate-x-1/2 rounded ${lit}`}
          />
        )}
      </div>
    </div>
  )
}
