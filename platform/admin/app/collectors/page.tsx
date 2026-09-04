import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * Everyone collecting Slash Coin, and what they have earned.
 *
 * Three columns here are the ones worth reading together, because they are the
 * question this screen exists to answer: **can this person be paid?** A
 * balance is not payable without a name and an address, and neither is payable
 * without a wallet — so a collector with 4,000 coins and no wallet is a
 * support conversation waiting to happen, and the list says so at a glance
 * rather than in a detail page nobody opens.
 *
 * Devices is the fraud signal, not a curiosity: one account across twenty
 * machines is what farming looks like, and the exclusion constraint in the
 * database means those twenty earn the time of one — but seeing it is still
 * how somebody notices.
 */
export default async function CollectorsPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const service = supabaseService()
  const [profiles, balances, devices] = await Promise.all([
    service.from('profiles').select('*').order('created_at', { ascending: false }).limit(500),
    service.from('coin_balances').select('user_id, total, updated_at'),
    service.from('devices').select('user_id, device_id')
  ])

  if (profiles.error) {
    return (
      <main>
        <h1>Collectors</h1>
        <p className="banner">
          Could not read the collector list ({profiles.error.message}). If this mentions a missing
          column, apply <code>supabase/migrations/20260903_collector_profiles.sql</code>.
        </p>
      </main>
    )
  }

  const coinsOf = new Map<string, number>()
  for (const row of balances.data ?? []) coinsOf.set(row.user_id, Number(row.total ?? 0))

  const machinesOf = new Map<string, number>()
  for (const row of devices.data ?? []) {
    machinesOf.set(row.user_id, (machinesOf.get(row.user_id) ?? 0) + 1)
  }

  const rows = (profiles.data ?? []).map((profile) => ({
    ...profile,
    coins: coinsOf.get(profile.id) ?? 0,
    machines: machinesOf.get(profile.id) ?? 0,
    payable: profile.profile_updated_at !== null && (profile.wallet_address ?? '') !== ''
  }))

  const complete = rows.filter((row) => row.profile_updated_at !== null).length
  const withWallet = rows.filter((row) => (row.wallet_address ?? '') !== '').length
  const suspended = rows.filter((row) => row.suspended).length
  const issued = rows.reduce((sum, row) => sum + row.coins, 0)

  return (
    <main>
      <h1>Collectors</h1>
      <p className="lede">
        Everyone earning Slash Coin, what they have collected, and whether we could actually pay
        them. Personal details are given by the collector in the browser and are readable here
        because an operator has to be able to answer questions about an account.
      </p>

      <div className="tiles">
        <div className="tile">
          <div className="k">Accounts</div>
          <div className="v">{rows.length.toLocaleString()}</div>
          <div className="sub">{suspended > 0 ? `${suspended} suspended` : 'none suspended'}</div>
        </div>
        <div className="tile">
          <div className="k">Details filled in</div>
          <div className="v">{complete.toLocaleString()}</div>
          <div className="sub">of {rows.length.toLocaleString()} accounts</div>
        </div>
        <div className="tile">
          <div className="k">Payout wallet set</div>
          <div className={withWallet === 0 ? 'v warn' : 'v'}>{withWallet.toLocaleString()}</div>
          <div className="sub">
            {withWallet === rows.length ? 'everyone' : `${rows.length - withWallet} without one`}
          </div>
        </div>
        <div className="tile">
          <div className="k">Coins issued</div>
          <div className="v">{issued.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
          <div className="sub">across every account</div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Name</th>
              <th>Country</th>
              <th className="num">Coins</th>
              <th className="num">Machines</th>
              <th>Payable</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="note">
                  Nobody has signed in to Slash Coin yet. An account appears here the first time
                  somebody signs in from the browser.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/collectors/${row.id}`}>{row.email || row.id.slice(0, 8)}</Link>
                    {row.suspended && <div className="pill rejected">suspended</div>}
                  </td>
                  <td>{row.full_name || <span className="note">not given</span>}</td>
                  <td>{row.country || <span className="note">—</span>}</td>
                  <td className="num">
                    {row.coins.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td className="num">
                    {row.machines > 5 ? (
                      <span style={{ color: 'var(--warn)' }}>{row.machines}</span>
                    ) : (
                      row.machines
                    )}
                  </td>
                  <td>
                    {row.payable ? (
                      <span className="pill active">ready</span>
                    ) : row.profile_updated_at === null ? (
                      <span className="pill pending">no details</span>
                    ) : (
                      <span className="pill pending">no wallet</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="note" style={{ marginTop: 14 }}>
        Newest first, up to 500. Machines is how many device ids an account has reported from — the
        ledger refuses overlapping time across all of them, so twenty machines earn the time of one,
        but a number that keeps climbing is worth a look.
      </p>
    </main>
  )
}
