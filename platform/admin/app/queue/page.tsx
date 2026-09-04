import { redirect } from 'next/navigation'
import { embedded } from '@slash/ad-shared'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { ReviewCard } from '@/components/ReviewCard'
import type { PendingCampaign } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function QueuePage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const supabase = supabaseService()
  const { data } = await supabase
    .from('campaigns')
    .select(
      'id, title, description, destination_link, image_path, placement_tier, total_cost, ' +
        'total_hours, starts_at, ends_at, created_at, advertisers ( company_name, contact_email )'
    )
    .eq('status', 'pending_review')
    .order('starts_at', { ascending: true })

  const pending = (data ?? []) as unknown as PendingCampaign[]

  // Creatives live in a private bucket, so the queue needs short-lived signed
  // URLs to show them. Ten minutes: long enough to review a queue, short enough
  // that a copied link is useless by the time it is shared.
  const previews = new Map<string, string>()
  for (const campaign of pending) {
    if (!campaign.image_path) continue
    const { data: signed } = await supabase.storage
      .from('campaign-assets')
      .createSignedUrl(campaign.image_path, 600)
    if (signed?.signedUrl) previews.set(campaign.id, signed.signedUrl)
  }

  const { data: recent } = await supabase
    .from('campaigns')
    .select('id, title, status, review_note, updated_at, advertisers ( company_name )')
    .in('status', ['scheduled', 'active', 'rejected', 'completed'])
    .order('updated_at', { ascending: false })
    .limit(15)

  return (
    <main>
      <h1>Review queue</h1>
      <p className="lede">
        Every one of these has been paid for. Approving puts it on the start page of every copy of
        Slash pointed at this deployment; rejecting refunds it in full and emails the advertiser.
      </p>

      {pending.length === 0 ? (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>
            Nothing waiting.
          </p>
        </div>
      ) : (
        <div className="stack">
          {pending.map((campaign) => (
            <ReviewCard
              key={campaign.id}
              campaign={campaign}
              previewUrl={previews.get(campaign.id) ?? null}
            />
          ))}
        </div>
      )}

      <h2>Recently decided</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Company</th>
              <th>Status</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {(recent ?? []).length === 0 ? (
              <tr>
                <td colSpan={4} className="note">
                  Nothing reviewed yet.
                </td>
              </tr>
            ) : (
              (recent ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td className="note">
                    {embedded<{ company_name: string }>(row.advertisers)?.company_name ?? '—'}
                  </td>
                  <td>
                    <span className={`pill ${row.status}`}>{row.status}</span>
                  </td>
                  <td className="note">{row.review_note ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}

