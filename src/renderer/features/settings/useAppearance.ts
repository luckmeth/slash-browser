import { useEffect } from 'react'
import type { Settings } from '@shared/types/settings'

/**
 * Applies the user's appearance preferences to the document.
 *
 * Written as CSS custom properties on the root element rather than as classes on
 * components, for the same reason `useWorkspaceTheme` is: every surface already
 * reads these tokens, so one write repaints the entire interface and anything
 * added later inherits the behaviour without being told about settings.
 *
 * Precedence with workspaces is deliberate. A workspace's colour wins over the
 * global accent while that workspace is active, because the workspace tint
 * exists to tell contexts apart — a stronger claim on the accent than a standing
 * preference. `useWorkspaceTheme` runs after this hook and simply overwrites the
 * same token.
 */

const ACCENTS: Record<string, string> = {
  // The product's own colour. Named rather than duplicated so "default" stays
  // meaningful if the brand accent ever changes.
  default: '#6ea8fe',
  blue: '#5b9dff',
  green: '#4ade80',
  purple: '#a78bfa',
  amber: '#fbbf24',
  rose: '#fb7185',
  teal: '#2dd4bf'
}

export function useAppearance(settings: Settings | null): void {
  const accent = settings?.accentColor ?? 'default'
  const density = settings?.uiDensity ?? 'comfortable'
  const opacity = settings?.glassOpacity ?? 55

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--color-accent', ACCENTS[accent] ?? ACCENTS['default']!)
  }, [accent])

  useEffect(() => {
    const root = document.documentElement
    // A single scale factor rather than a table of sizes: the layout is already
    // built from relative spacing, so one number moves all of it coherently.
    root.style.setProperty('--density-scale', density === 'compact' ? '0.85' : '1')
    root.dataset['density'] = density
  }, [density])

  useEffect(() => {
    const root = document.documentElement
    const alpha = Math.min(100, Math.max(0, opacity)) / 100

    root.style.setProperty('--glass-base', `rgba(14, 17, 24, ${alpha.toFixed(2)})`)
    root.style.setProperty('--glass-high', `rgba(20, 24, 33, ${Math.min(1, alpha + 0.12).toFixed(2)})`)

    // At full opacity the blur is pure cost: nothing behind the bars is visible
    // through them, so the GPU work buys nothing. Dropping it is what makes this
    // a genuine performance setting on a weak machine rather than only a taste
    // one.
    root.style.setProperty('--blur-md', alpha >= 0.99 ? '0px' : '18px')
  }, [opacity])
}
