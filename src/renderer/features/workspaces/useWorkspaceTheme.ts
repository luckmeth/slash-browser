import { useEffect } from 'react'
import type { WorkspaceColor } from '@shared/types/workspace'

/**
 * Tints the whole chrome to the active workspace's colour.
 *
 * Switching workspace was previously legible only from a small highlight in the
 * left rail — you had to *check* which context you were in rather than simply
 * knowing. Colouring the accent and adding a wash behind the glass makes the
 * switch something you feel, which is the entire point of having workspaces
 * rather than one long tab strip.
 *
 * Applied by overriding `--color-accent` on the document root rather than by
 * swapping class names on individual components. Every surface already draws
 * from that token, so the whole UI follows from one write — and anything added
 * later inherits the behaviour without being told about workspaces.
 *
 * Deliberately restrained: the accent and a barely-there wash, not a repainted
 * interface. A browser whose chrome changes colour dramatically every time you
 * switch context stops feeling like one application.
 */

/** Accent per workspace colour, matched to the rail's existing palette. */
const ACCENT: Record<WorkspaceColor, string> = {
  blue: '#5b9dff',
  green: '#4ade80',
  purple: '#a78bfa',
  amber: '#fbbf24',
  rose: '#fb7185',
  teal: '#2dd4bf',
  // The default. Keeps the product's own accent rather than tinting toward a
  // colour the user did not choose.
  slate: '#7dd3fc'
}

/** A wash laid behind the translucent bars. Low alpha by design. */
const WASH: Record<WorkspaceColor, string> = {
  blue: 'rgba(91, 157, 255, 0.07)',
  green: 'rgba(74, 222, 128, 0.06)',
  purple: 'rgba(167, 139, 250, 0.07)',
  amber: 'rgba(251, 191, 36, 0.06)',
  rose: 'rgba(251, 113, 133, 0.06)',
  teal: 'rgba(45, 212, 191, 0.06)',
  slate: 'rgba(0, 0, 0, 0)'
}

export function useWorkspaceTheme(color: WorkspaceColor | null): void {
  useEffect(() => {
    const root = document.documentElement
    if (!color) {
      root.style.removeProperty('--color-accent')
      root.style.removeProperty('--workspace-wash')
      return
    }

    root.style.setProperty('--color-accent', ACCENT[color])
    root.style.setProperty('--workspace-wash', WASH[color])

    return () => {
      root.style.removeProperty('--color-accent')
      root.style.removeProperty('--workspace-wash')
    }
  }, [color])
}
