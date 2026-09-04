import { redirect } from 'next/navigation'
import type { CoinConfig } from '@slash/ad-shared'
import { CoinControls, CoinPreview } from '@/components/CoinControls'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * Slash Coin, from the operator side.
 *
 * These four figures — the rate, the daily maximum, the published value of a
 * coin and the launch date — are decided here and nowhere else. The browser
 * holds no defaults for them and no configuration file carries a second copy:
 * it reads `coin_state()` and renders what it is given, showing **Pending**
 * for anything unset. So an empty box on this page is a visible state in front
 * of every user, which is the reason the screen shows what each one will look
 * like rather than only what it holds.
 *
 * The counts underneath are read from the ledger, not computed here: `total`
 * in `coin_balances` is what the crediting function wrote, and this page is a
 * reader of it like everything else.
 */
export default async function CoinPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const service = supabaseService()
  const { data: row, error } = await service.from('coin_config').select('*').eq('id', true).maybeSingle()

  const accounts = await service.from('profiles').select('id', { count: 'exact', head: true })
  const suspended = await service
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('suspended', true)
  const balances = await service.from('coin_balances').select('total')

  const issued = (balances.data ?? []).reduce((sum, entry) => sum + Number(entry.total ?? 0), 0)

  // A deployment that has not run the coin migration has no table at all, and
  // a page that throws is a worse answer than a page that says which file to
  // apply.
  if (!row) {
    return (
      <main>
        <h1>Slash Coin</h1>
        <p className="banner">
          No <code>coin_config</code> row was found
          {error ? <> ({error.message})</> : null}. Apply{' '}
          <code>supabase/migrations/20260830_slash_coin.sql</code> and{' '}
          <code>supabase/migrations/20260903_coin_controls.sql</code> to this project, then reload
          this page.
        </p>
      </main>
    )
  }

  const config: CoinConfig = {
    // `earning_active` arrived after the table did. Absent means a database
    // that predates the switch, which is running normally — the same reading
    // the browser takes, and for the same reason: unknown is not paused.
    earningActive: row.earning_active !== false,
    coinsPerHour: Number(row.coins_per_hour ?? 0),
    dailyCapSeconds: Number(row.daily_cap_seconds ?? 0),
    coinToUsd: row.coin_to_usd === null || row.coin_to_usd === undefined ? null : Number(row.coin_to_usd),
    launchAt: row.launch_at ? Date.parse(row.launch_at) : null,
    maxAgeDays: Number(row.max_age_days ?? 7),
    clockSkewSeconds: Number(row.clock_skew_seconds ?? 120)
  }

  return (
    <main>
      <h1>Slash Coin</h1>
      <p className="lede">
        What browsers earn, what a coin is said to be worth, and when the pre-launch period ends.
        Every figure here is read by the browser and shown to the people collecting.
      </p>

      <div className="tiles">
        <div className="tile">
          <div className="k">Earning</div>
          <div className={config.earningActive ? 'v small good' : 'v small warn'}>
            <span className={config.earningActive ? 'dot live' : 'dot off'} aria-hidden="true" />
            {config.earningActive ? 'Active' : 'Paused'}
          </div>
          <div className="sub">
            {config.earningActive ? 'accruing on every signed-in browser' : 'nothing is accruing'}
          </div>
        </div>
        <div className="tile">
          <div className="k">Collectors</div>
          <div className="v">{(accounts.count ?? 0).toLocaleString()}</div>
          <div className="sub">
            {(suspended.count ?? 0) > 0
              ? `${suspended.count} suspended`
              : 'no accounts suspended'}
          </div>
        </div>
        <div className="tile">
          <div className="k">Coins issued</div>
          <div className="v">{issued.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
          <div className="sub">from the ledger, all time</div>
        </div>
        <div className="tile">
          <div className="k">Coin value</div>
          <div className={config.coinToUsd === null ? 'v small warn' : 'v small'}>
            {config.coinToUsd === null ? 'Pending' : `$${config.coinToUsd.toFixed(4)}`}
          </div>
          <div className="sub">
            {config.coinToUsd === null
              ? 'nothing published yet'
              : `${issued > 0 ? `$${(issued * config.coinToUsd).toFixed(2)} issued at that rate` : 'indicative only'}`}
          </div>
        </div>
      </div>

      <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Publishing a value is a claim about money</h3>
        <p className="note">
          The browser calls it indicative and says coins cannot be bought, sold or exchanged during
          pre-launch — but a figure against a balance somebody has spent a month collecting is a
          figure they will quote back. Granting future value for present activity is the structure
          regulators look at hardest. Leaving the field empty shows <strong>Pending</strong>, which
          is honest and costs nothing.
        </p>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(260px, 1fr)' }}>
        <div>
          <CoinControls config={config} />
        </div>
        <div>
          <h2 style={{ marginTop: 0, fontSize: 13, textTransform: 'uppercase', color: 'var(--muted)', letterSpacing: '0.05em' }}>
            What the browser shows
          </h2>
          <CoinPreview config={config} />
          <p className="note" style={{ marginTop: 12 }}>
            The saved values, in the wording the rewards page uses. It refreshes when a browser next
            reads the state — within a few minutes of a change, not instantly.
          </p>
        </div>
      </div>
    </main>
  )
}
