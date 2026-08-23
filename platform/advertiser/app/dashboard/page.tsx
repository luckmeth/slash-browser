import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatCents } from '@slash/ad-shared'
import { currentAdvertiser, supabaseServer } from '@/lib/supabase/server'
import { loadSettings } from '@/lib/settings'
import { PayButton } from '@/components/PayButton'

export const dynamic = 'force-dynamic'

const STATUS_TEXT: Record<string, string> = {
  pending_review: 'Being reviewed',
  approved_unpaid: 'Approved — pay to go live',
  pending_payment: 'Not paid yet',
  scheduled: 'Paid, waiting to start',
  active: 'Running now',
  rejected: 'Not approved',
  completed: 'Finished',
  cancelled: 'Cancelled'
}

interface CampaignRow {
  id: string
  title: string
  status: string
  total_cost: number | string
  total_hours: number | string
  starts_at: string
  ends_at: string
  review_note: string | null
  placement_tier: string
}

export default async function DashboardPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  const advertiser = await currentAdvertiser()
  if (!advertiser) redirect('/login')

  const params = await searchParams
  const supabase = await supabaseServer()
  const settings = await loadSettings()

  // Every query below runs as this advertiser under RLS, so "their own" is
  // enforced by the database rather than by remembering to filter here.
  const [{ data: campaigns }, { data: payments }, { data: counts }] = await Promise.all([
    supabase
      .from('campaigns')
      .select(
        'id, title, status, total_cost, total_hours, starts_at, ends_at, review_note, placement_tier'
      )
      .order('created_at', { ascending: false }),
    supabase
      .from('payments')
      .select('id, amount, status, paid_at, campaign_id')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('delivery_counts').select('campaign_id, impressions, clicks')
  ])

  const totals = new Map<string, { impressions: number; clicks: number }>()
  for (const row of counts ?? []) {
    const current = totals.get(row.campaign_id) ?? { impressions: 0, clicks: 0 }
    totals.set(row.campaign_id, {
      impressions: current.impressions + Number(row.impressions),
      clicks: current.clicks + Number(row.clicks)
    })
  }

  const rows = (campaigns ?? []) as CampaignRow[]

  return (
    <main>
      <h1>Your campaigns</h1>
      <p className="lede">{advertiser.company_name}</p>

      {params.submitted !== undefined && (
        <p className="banner">
          Submitted. Somebody reads every campaign before it runs — you will be emailed when it is
          approved, and you pay then. Nothing has been charged.
        </p>
      )}

      {params.paid !== undefined && (
        <p className="banner">
          Payment received. Your campaign will start at its scheduled time, and you will get one
          more email when it goes live.
        </p>
      )}

      {rows.length === 0 ? (
        <div className="card">
          <h3>Nothing booked yet</h3>
          <p className="note">
            A campaign takes about two minutes to put together. You will see the exact price before
            you pay anything.
          </p>
          <p style={{ marginTop: 14, marginBottom: 0 }}>
            <Link href="/campaigns/new" className="button">
              Build your first campaign
            </Link>
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Runs</th>
                <th className="num">Cost</th>
                <th className="num">Shown</th>
                <th className="num">Clicks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((campaign) => {
                const stat = totals.get(campaign.id) ?? { impressions: 0, clicks: 0 }
                return (
                  <tr key={campaign.id}>
                    <td>
                      <strong>{campaign.title}</strong>
                      <div className="note">{campaign.placement_tier.replace(/_/g, ' ')}</div>
                      {campaign.review_note && (
                        <div className="note" style={{ color: 'var(--bad)' }}>
                          {campaign.review_note}
                        </div>
                      )}
                      {(campaign.status === 'approved_unpaid' ||
                        campaign.status === 'pending_payment') && (
                        <div style={{ marginTop: 8 }}>
                          <PayButton campaignId={campaign.id} />
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${campaign.status}`}>
                        {STATUS_TEXT[campaign.status] ?? campaign.status}
                      </span>
                    </td>
                    <td className="note">
                      {new Date(campaign.starts_at).toLocaleString()}
                      <br />
                      to {new Date(campaign.ends_at).toLocaleString()}
                      <br />
                      {Number(campaign.total_hours)} hours
                    </td>
                    <td className="num">
                      {formatCents(
                        Math.round(Number(campaign.total_cost) * 100),
                        settings.currency
                      )}
                    </td>
                    <td className="num">{stat.impressions.toLocaleString()}</td>
                    <td className="num">{stat.clicks.toLocaleString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <p className="note" style={{ marginTop: 12 }}>
          Shown and click figures arrive in batches a few hours behind, and a browser that is not
          reopened never sends its share — so they run low and are indicative rather than exact. You
          are billed for hours, not for these.
        </p>
      )}

      <h2>Payments</h2>
      {(payments ?? []).length === 0 ? (
        <p className="note">Nothing yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Campaign</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).map((payment) => (
                <tr key={payment.id}>
                  <td className="note">
                    {payment.paid_at ? new Date(payment.paid_at).toLocaleDateString() : '—'}
                  </td>
                  <td>{rows.find((row) => row.id === payment.campaign_id)?.title ?? '—'}</td>
                  <td>
                    <span className={`pill ${payment.status}`}>{payment.status}</span>
                  </td>
                  <td className="num">
                    {formatCents(Math.round(Number(payment.amount) * 100), settings.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 28 }}>
        <Link href="/campaigns/new" className="button">
          New campaign
        </Link>
      </p>
    </main>
  )
}
