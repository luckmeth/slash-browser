import { redirect } from 'next/navigation'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { TierEditor } from '@/components/TierEditor'

export const dynamic = 'force-dynamic'

export default async function PricingPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const supabase = supabaseService()
  const [{ data: tiers }, { data: history }] = await Promise.all([
    supabase
      .from('pricing_config')
      .select(
        'placement_tier, display_name, description, hourly_rate, min_hours, max_concurrent, active'
      )
      .order('hourly_rate', { ascending: false }),
    supabase
      .from('price_history')
      .select('placement_tier, hourly_rate, changed_at')
      .order('changed_at', { ascending: false })
      .limit(20)
  ])

  return (
    <main>
      <h1>Pricing</h1>
      <p className="lede">
        Changes take effect immediately — the public site reads these rates directly. Campaigns
        already paid for keep the rate they were charged.
      </p>

      <div className="stack">
        {(tiers ?? []).map((tier) => (
          <TierEditor key={tier.placement_tier} tier={tier} />
        ))}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3>Two numbers worth understanding before you change them</h3>
        <p className="note">
          <strong>Minimum hours</strong> — browsers collect adverts every six hours, so a block much
          shorter than a day is mostly paid-for time that never reaches anybody. It is also what
          keeps a booking worth more than the card fee on it.
        </p>
        <p className="note">
          <strong>Maximum at once</strong> — every live creative&rsquo;s image is delivered inside
          the batch each reader downloads. This is not only an inventory limit; it is the size of a
          file every user of the browser fetches. Raising it makes the browser slower for people
          who are not your customers.
        </p>
      </div>

      <h2>Rate changes</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Placement</th>
              <th className="num">Rate</th>
            </tr>
          </thead>
          <tbody>
            {(history ?? []).length === 0 ? (
              <tr>
                <td colSpan={3} className="note">
                  No changes recorded yet.
                </td>
              </tr>
            ) : (
              (history ?? []).map((row, index) => (
                <tr key={`${row.placement_tier}-${row.changed_at}-${index}`}>
                  <td className="note">{new Date(row.changed_at).toLocaleString()}</td>
                  <td>{row.placement_tier.replace(/_/g, ' ')}</td>
                  <td className="num">{Number(row.hourly_rate).toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
