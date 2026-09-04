import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatCents } from '@slash/ad-shared'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * Every advertiser account, with what they have actually run.
 *
 * The review queue answers "what is waiting for me"; this answers "who are
 * these people". They are different questions, and the second one is the one
 * asked when somebody emails asking about an invoice, or when a campaign is
 * the fourth from a company whose first three were rejected — which is
 * invisible from a queue showing one campaign at a time.
 *
 * Spend counts **paid** campaigns only. A quoted total is not money, and a
 * column that adds up unpaid quotes is a number somebody will eventually
 * repeat in a meeting.
 */
export default async function AdvertisersPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const service = supabaseService()
  const [advertisers, campaigns] = await Promise.all([
    service.from('advertisers').select('*').order('created_at', { ascending: false }).limit(500),
    service.from('campaigns').select('advertiser_id, status, total_cost')
  ])

  if (advertisers.error) {
    return (
      <main>
        <h1>Advertisers</h1>
        <p className="banner">Could not read advertisers ({advertisers.error.message}).</p>
      </main>
    )
  }

  const PAID = new Set(['scheduled', 'active', 'completed'])
  const stats = new Map<string, { total: number; paid: number; spend: number; waiting: number }>()
  for (const row of campaigns.data ?? []) {
    const id = String(row.advertiser_id)
    const entry = stats.get(id) ?? { total: 0, paid: 0, spend: 0, waiting: 0 }
    entry.total += 1
    if (PAID.has(String(row.status))) {
      entry.paid += 1
      entry.spend += Number(row.total_cost ?? 0)
    }
    if (row.status === 'pending_review') entry.waiting += 1
    stats.set(id, entry)
  }

  const rows = advertisers.data ?? []
  const withProfile = rows.filter((row) => row.profile_updated_at !== null).length
  const totalSpend = [...stats.values()].reduce((sum, entry) => sum + entry.spend, 0)

  return (
    <main>
      <h1>Advertisers</h1>
      <p className="lede">
        Companies with an account. Their company profile is filled in by them in the advertiser
        portal — the same details every campaign they submit is attached to.
      </p>

      <div className="tiles">
        <div className="tile">
          <div className="k">Accounts</div>
          <div className="v">{rows.length.toLocaleString()}</div>
          <div className="sub">
            {rows.filter((row) => row.status === 'suspended').length} suspended
          </div>
        </div>
        <div className="tile">
          <div className="k">Company profile</div>
          <div className="v">{withProfile.toLocaleString()}</div>
          <div className="sub">of {rows.length.toLocaleString()} filled in</div>
        </div>
        <div className="tile">
          <div className="k">Waiting on review</div>
          <div className={[...stats.values()].some((s) => s.waiting > 0) ? 'v warn' : 'v'}>
            {[...stats.values()].reduce((sum, entry) => sum + entry.waiting, 0)}
          </div>
          <div className="sub">
            <Link href="/queue">open the queue →</Link>
          </div>
        </div>
        <div className="tile">
          <div className="k">Paid</div>
          <div className="v small">{formatCents(totalSpend)}</div>
          <div className="sub">campaigns that went live or are scheduled</div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Contact</th>
              <th>Country</th>
              <th className="num">Campaigns</th>
              <th className="num">Paid</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="note">
                  No advertiser accounts yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const entry = stats.get(row.id) ?? { total: 0, paid: 0, spend: 0, waiting: 0 }
                return (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/advertisers/${row.id}`}>{row.company_name}</Link>
                      {row.profile_updated_at === null && (
                        <div className="note">profile not filled in</div>
                      )}
                    </td>
                    <td className="note">{row.contact_email}</td>
                    <td>{row.country || <span className="note">—</span>}</td>
                    <td className="num">
                      {entry.total}
                      {entry.waiting > 0 && (
                        <span style={{ color: 'var(--warn)' }}> · {entry.waiting} waiting</span>
                      )}
                    </td>
                    <td className="num">{formatCents(entry.spend)}</td>
                    <td>
                      <span className={row.status === 'active' ? 'pill active' : 'pill rejected'}>
                        {row.status}
                      </span>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
