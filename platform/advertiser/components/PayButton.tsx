'use client'

import { useState } from 'react'

/**
 * Resumes checkout for a campaign that was saved but never paid for.
 *
 * Exists because the builder can succeed at saving and fail at reaching Stripe
 * — a full inventory tier, a network blip. Without this the campaign would be
 * stranded: visible, unpaid, and with no way forward except building it again.
 */
export function PayButton({ campaignId }: { campaignId: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            const response = await fetch('/api/checkout', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ campaignId })
            })
            const payload = (await response.json()) as { url?: string; error?: string }
            if (payload.url) {
              window.location.assign(payload.url)
              return
            }
            setError(payload.error ?? 'Checkout could not be started.')
          } catch {
            setError('Checkout could not be reached.')
          }
          setBusy(false)
        }}
      >
        {busy ? 'One moment…' : 'Pay now'}
      </button>
      {error !== '' && <div className="error">{error}</div>}
    </>
  )
}
