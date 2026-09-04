'use client'

import { useActionState } from 'react'
import { formatCents } from '@slash/ad-shared'
import { saveTier, type SaveResult } from '@/app/pricing/actions'

interface TierRow {
  placement_tier: string
  display_name: string
  description: string
  hourly_rate: number | string
  min_hours: number
  max_concurrent: number
  active: boolean
}

export function TierEditor({ tier }: { tier: TierRow }): React.JSX.Element {
  const [state, action, saving] = useActionState<SaveResult, FormData>(saveTier, undefined)
  const rateCents = Math.round(Number(tier.hourly_rate) * 100)

  return (
    <form className="card" action={action}>
      <input type="hidden" name="placementTier" value={tier.placement_tier} />
      <h3>
        {tier.display_name}{' '}
        <span className="note">({tier.placement_tier})</span>
      </h3>
      <p className="note">
        A minimum booking currently costs {formatCents(rateCents * tier.min_hours)}.
      </p>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 150px' }}>
          <label htmlFor={`rate-${tier.placement_tier}`}>Hourly rate</label>
          <input
            id={`rate-${tier.placement_tier}`}
            name="hourlyRate"
            type="number"
            step="0.01"
            min="0"
            defaultValue={Number(tier.hourly_rate).toFixed(2)}
          />
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <label htmlFor={`min-${tier.placement_tier}`}>Minimum hours</label>
          <input
            id={`min-${tier.placement_tier}`}
            name="minHours"
            type="number"
            min="1"
            step="1"
            defaultValue={tier.min_hours}
          />
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <label htmlFor={`max-${tier.placement_tier}`}>Maximum at once</label>
          <input
            id={`max-${tier.placement_tier}`}
            name="maxConcurrent"
            type="number"
            min="1"
            step="1"
            defaultValue={tier.max_concurrent}
          />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label htmlFor={`name-${tier.placement_tier}`}>Display name</label>
        <input
          id={`name-${tier.placement_tier}`}
          name="displayName"
          defaultValue={tier.display_name}
          maxLength={80}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <label htmlFor={`desc-${tier.placement_tier}`}>Description shown to advertisers</label>
        <textarea
          id={`desc-${tier.placement_tier}`}
          name="description"
          defaultValue={tier.description}
          maxLength={300}
        />
      </div>

      <label className="row" style={{ marginTop: 12, gap: 8 }}>
        <input
          type="checkbox"
          name="active"
          defaultChecked={tier.active}
          style={{ width: 'auto' }}
        />
        <span>On sale</span>
      </label>
      <p className="note">
        Switching this off hides the placement from the public site and stops new bookings.
        Campaigns already booked keep running.
      </p>

      {state && 'error' in state && <p className="error">{state.error}</p>}
      {state && 'ok' in state && (
        <p className="note" style={{ color: 'var(--good)' }}>
          {state.ok}
        </p>
      )}

      <button type="submit" disabled={saving} style={{ marginTop: 8 }}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
