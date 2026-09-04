import type { WorkspaceColor } from '@shared/types/workspace'

/**
 * Accent colours, resolved here rather than stored in the database.
 *
 * The workspace row keeps a colour *id*, so a future theme can change every
 * workspace's appearance without a data migration.
 */
export const COLOR_CLASSES: Record<
  WorkspaceColor,
  {
    dot: string
    ring: string
    tint: string
    /**
     * A coloured edge along the top of a grouped tab.
     *
     * Deliberately a border rather than a background: a tab tinted strongly
     * enough to read as "grouped" competes with the active-tab highlight, and
     * then neither is obvious. A 2px edge is unmistakable and costs the tab's
     * own state nothing.
     */
    groupEdge: string
  }
> = {
  blue: {
    dot: 'bg-sky-400',
    ring: 'ring-sky-400/60',
    tint: 'bg-sky-400/10',
    groupEdge: 'border-t-2 border-sky-400/70'
  },
  green: {
    dot: 'bg-emerald-400',
    ring: 'ring-emerald-400/60',
    tint: 'bg-emerald-400/10',
    groupEdge: 'border-t-2 border-emerald-400/70'
  },
  purple: {
    dot: 'bg-violet-400',
    ring: 'ring-violet-400/60',
    tint: 'bg-violet-400/10',
    groupEdge: 'border-t-2 border-violet-400/70'
  },
  amber: {
    dot: 'bg-amber-400',
    ring: 'ring-amber-400/60',
    tint: 'bg-amber-400/10',
    groupEdge: 'border-t-2 border-amber-400/70'
  },
  rose: {
    dot: 'bg-rose-400',
    ring: 'ring-rose-400/60',
    tint: 'bg-rose-400/10',
    groupEdge: 'border-t-2 border-rose-400/70'
  },
  teal: {
    dot: 'bg-teal-400',
    ring: 'ring-teal-400/60',
    tint: 'bg-teal-400/10',
    groupEdge: 'border-t-2 border-teal-400/70'
  },
  slate: {
    dot: 'bg-slate-400',
    ring: 'ring-slate-400/60',
    tint: 'bg-slate-400/10',
    groupEdge: 'border-t-2 border-slate-400/70'
  }
}
