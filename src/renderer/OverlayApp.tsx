import { useEffect, useState } from 'react'
import type { OverlayState } from '@shared/ipc/contracts'
import { SuggestionList } from './features/omnibox/SuggestionList'
import { SpikeReport } from './features/diagnostics/SpikeReport'
import { PermissionPrompt } from './features/permissions/PermissionPrompt'

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
    // Same race as the suggestion state: the surface that caused this document
    // to load was announced before it could listen, so ask what is current.
    // Permissions are checked first — a prompt outranks a dropdown.
    void (async () => {
      const pending = await window.browser.invoke('permissions:getPending', undefined)
      if (pending.ok && pending.value) {
        setSurface('permission-prompt')
        return
      }
      const omnibox = await window.browser.invoke('omnibox:getState', undefined)
      if (omnibox.ok && omnibox.value) setSurface('command-bar')
    })()
    return window.browser.on('overlay:stateChanged', (state) => setSurface(state.surface))
  }, [])

  switch (surface) {
    case 'command-bar':
      return <SuggestionList />
    case 'permission-prompt':
      return <PermissionPrompt />
    case 'spike':
      return <SpikeReport />
    case 'none':
    default:
      return null
  }
}
