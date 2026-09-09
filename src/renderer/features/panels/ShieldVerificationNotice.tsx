import { useEffect, useState } from 'react'
import type { InvokeResponse } from '@shared/ipc/contracts'

type Verification = InvokeResponse<'shield:verification'>

/**
 * Whether Slash has actually seen its ad strip run.
 *
 * **Why a settings screen needs this at all.** The strip stopped running
 * entirely for a period, and every signal available said it was working — the
 * debugger accepted the command, the log said the scripts were installed, and
 * this very screen said the blocker was on. Adverts played. The switch above
 * describes an *intention*; this line describes an *observation*, and they are
 * not the same thing.
 *
 * It says nothing until there is something to say. A browser that opens its
 * settings shouting about an unverified ad blocker would train people to ignore
 * exactly the line that matters on the day it turns red.
 */
export function ShieldVerificationNotice(): React.JSX.Element | null {
  const [state, setState] = useState<Verification | null>(null)

  useEffect(() => {
    void window.browser.invoke('shield:verification', undefined).then((result) => {
      if (result.ok) setState(result.value)
    })
    // Pushed, because the check happens seconds after a YouTube page settles —
    // which is almost never while this screen is open.
    return window.browser.on('shield:verificationChanged', (next) => setState(next))
  }, [])

  if (!state) return null
  if (state.verdict === 'off') return null
  // Nothing observed yet. Saying "unverified" here would be alarming and wrong:
  // no YouTube page has been opened this session, so there was nothing to check.
  if (state.verdict === 'unknown' && state.at === null) return null

  const when =
    state.at === null
      ? null
      : new Date(state.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (state.verdict === 'verified') {
    return (
      <div className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--color-good)]/25 bg-[var(--color-good)]/8 px-3 py-2">
        <span aria-hidden="true" className="mt-px text-[12px] text-[var(--color-good)]">
          ✓
        </span>
        <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          Checked on {state.host ?? 'YouTube'} at {when} — the ad strip was running on the page.
        </p>
      </div>
    )
  }

  if (state.verdict === 'failed') {
    return (
      <div
        role="status"
        className="mt-2 rounded-lg border border-[var(--color-bad)]/35 bg-[var(--color-bad)]/10 px-3 py-2"
      >
        <p className="text-[12px] font-medium text-[var(--color-text-primary)]">
          The ad strip did not run on the last YouTube page
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          Checked on {state.host ?? 'YouTube'} at {when}. Adverts will play. This is a fault rather
          than a setting — the switch is on and the script did not reach the page. Reloading the tab
          is worth trying first; if it persists, it is a bug worth reporting.
        </p>
      </div>
    )
  }

  return (
    <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
      Could not check the last YouTube page, so whether the ad strip ran is unknown. This is not
      evidence either way.
    </p>
  )
}
