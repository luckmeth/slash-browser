import { useEffect, useState } from 'react'
import type { OverlayState } from '@shared/ipc/contracts'
import { SuggestionList } from './features/omnibox/SuggestionList'
import { SpikeReport } from './features/diagnostics/SpikeReport'
import { PermissionPrompt } from './features/permissions/PermissionPrompt'
import { TabSearch } from './features/tabsearch/TabSearch'
import { Reader } from './features/reader/Reader'
import { ShieldPanel } from './features/shield/ShieldPanel'
import { Onboarding } from './features/onboarding/Onboarding'
import { PasswordFillPanel } from './features/passwords/PasswordFillPanel'
import { CommandPalette } from './features/palette/CommandPalette'
import { ShortcutSheet } from './features/shortcuts/ShortcutSheet'
import { CleanupPanel } from './features/cleanup/CleanupPanel'
import { NoticeToast } from './features/notice/NoticeToast'
import { PrintPreview } from './features/print/PrintPreview'

/**
 * Root of the overlay document.
 *
 * This is the only surface that can draw *over* page content, because a
 * `WebContentsView` is a native layer composited above the DOM and CSS `z-index`
 * in the chrome document cannot reach it. Everything that must float lives here
 * and is chosen by the current surface.
 *
 * Its window is sized by the main process to exactly the region the surface
 * needs — overlay hit-testing is rectangular, so a full-window overlay for a
 * small dropdown would swallow every click on the page behind it.
 */
export function OverlayApp(): React.JSX.Element | null {
  const [surface, setSurface] = useState<OverlayState['surface']>('none')

  useEffect(() => {
    // The surface that caused this document to load was announced before it
    // could listen, so ask the controller what is current. This used to infer
    // the surface from per-feature state (pending permission, omnibox open),
    // which silently covered only those two surfaces — the first-ever showing
    // of any other kind mounted to nothing, leaving an invisible modal overlay
    // that swallowed every click.
    void window.browser.invoke('overlay:getState', undefined).then((result) => {
      if (result.ok && result.value.visible) setSurface(result.value.surface)
    })
    return window.browser.on('overlay:stateChanged', (state) => setSurface(state.surface))
  }, [])

  switch (surface) {
    case 'command-bar':
      return <SuggestionList />
    case 'permission-prompt':
      return <PermissionPrompt />
    case 'tab-search':
      return <TabSearch />
    case 'reader':
      return <Reader />
    case 'shield':
      return <ShieldPanel />
    case 'onboarding':
      return <Onboarding />
    case 'passwords':
      return <PasswordFillPanel />
    case 'command-palette':
      return <CommandPalette />
    case 'shortcuts':
      return <ShortcutSheet />
    case 'cleanup':
      return <CleanupPanel />
    case 'notice':
      return <NoticeToast />
    case 'print':
      return <PrintPreview />
    case 'spike':
      return <SpikeReport />
    case 'none':
    default:
      return null
  }
}
