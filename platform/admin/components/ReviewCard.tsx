'use client'

import { useActionState } from 'react'
import { embedded, formatCents } from '@slash/ad-shared'
import { approve, reject, type Decision } from '@/app/queue/actions'
import type { PendingCampaign } from '@/lib/types'

/**
 * One campaign awaiting a decision, shown as the reader will see it.
 *
 * The destination is printed in full rather than linked. An operator clicking
 * through from a review queue is exactly the click an advertiser would want to
 * make cheap — and a link whose text and target differ is the oldest trick
 * there is. Read the URL, then open it yourself if you want to.
 */
export function ReviewCard({
  campaign,
  previewUrl
}: {
  campaign: PendingCampaign
  previewUrl: string | null
}): React.JSX.Element {
  const [approveState, approveAction, approving] = useActionState<Decision, FormData>(
    approve,
    undefined
  )
  const [rejectState, rejectAction, rejecting] = useActionState<Decision, FormData>(
    reject,
    undefined
  )
  const state = approveState ?? rejectState
  const advertiser = embedded(campaign.advertisers)

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt=""
            style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover', flex: 'none' }}
          />
        ) : (
          <div
            className="note"
            style={{
              width: 72,
              height: 72,
              borderRadius: 8,
              border: '1px dashed var(--edge)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              flex: 'none'
            }}
          >
            no image
          </div>
        )}

        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h3 style={{ marginBottom: 2 }}>{campaign.title}</h3>
          {campaign.description && <p className="note">{campaign.description}</p>}
          <p className="note" style={{ wordBreak: 'break-all' }}>
            {advertiser?.company_name} ({advertiser?.contact_email}) →{' '}
            <code>{campaign.destination_link}</code>
          </p>
          <p className="note">
            {campaign.placement_tier.replace(/_/g, ' ')} · {Number(campaign.total_hours)} hours ·{' '}
            {formatCents(Math.round(Number(campaign.total_cost) * 100))} paid
            <br />
            {new Date(campaign.starts_at).toLocaleString()} to{' '}
            {new Date(campaign.ends_at).toLocaleString()}
          </p>
        </div>
      </div>

      {state && 'error' in state && <p className="error">{state.error}</p>}
      {state && 'ok' in state && (
        <p className="note" style={{ color: 'var(--good)' }}>
          {state.ok}
        </p>
      )}

      <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <form action={approveAction}>
          <input type="hidden" name="campaignId" value={campaign.id} />
          <button type="submit" disabled={approving || rejecting}>
            {approving ? 'Approving…' : 'Approve'}
          </button>
        </form>

        <form action={rejectAction} style={{ flex: '1 1 280px' }}>
          <input type="hidden" name="campaignId" value={campaign.id} />
          <label htmlFor={`note-${campaign.id}`}>Reason (sent to the advertiser)</label>
          <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
            <input
              id={`note-${campaign.id}`}
              name="note"
              placeholder="Why this cannot run"
              maxLength={300}
            />
            <button type="submit" className="danger" disabled={approving || rejecting}>
              {rejecting ? 'Refunding…' : 'Reject & refund'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
