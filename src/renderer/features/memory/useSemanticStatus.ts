import { useCallback, useEffect, useState } from 'react'
import type { SemanticStatus } from '@shared/types/semantic'

/**
 * Live state of the local embedding layer.
 *
 * Fetched once and then pushed: preparing the model involves a download that
 * can run for minutes, and polling for a progress bar is both jerkier and more
 * expensive than being told.
 */
export function useSemanticStatus(): {
  status: SemanticStatus | null
  setEnabled: (enabled: boolean) => void
} {
  const [status, setStatus] = useState<SemanticStatus | null>(null)

  useEffect(() => {
    void window.browser.invoke('memory:semanticStatus', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
    return window.browser.on('memory:semanticChanged', setStatus)
  }, [])

  const setEnabled = useCallback((enabled: boolean): void => {
    // The reply carries the state immediately after the switch — `preparing`,
    // not `ready`. Everything after that arrives on the event.
    void window.browser
      .invoke('memory:setSemanticEnabled', { enabled })
      .then((result) => {
        if (result.ok) setStatus(result.value)
      })
  }, [])

  return { status, setEnabled }
}
