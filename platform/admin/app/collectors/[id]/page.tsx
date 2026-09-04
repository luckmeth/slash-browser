import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { SuspendButton } from '@/components/SuspendButton'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * One collector: who they are, what they earned, and on what.
 *
 * The ledger at the bottom is the point of the page. `claimed` beside
 * `qualifying` is the signal worth watching — a large and persistent gap
 * between them means a client repeatedly asking for more time than the cap
 * allows, which is what an edited client looks like from the server. Every row
 * here was written by `record_coin_intervals` and by nothing else; there is no
 * client write path into it at all.
 */
export default async function CollectorPage({
  params
}: {
  params: Promise<{ id: string }>
}): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')
  const { id } = await params

  const service = supabaseService()
  const [profile, balance, intervals, devices] = await Promise.all([
    service.from('profiles').select('*').eq('id', id).maybeSingle(),
    service.from('coin_balances').select('total, updated_at').eq('user_id', id).maybeSingle(),
    service
      .from('coin_intervals')
      .select('started_at, ended_at, qualifying_seconds, claimed_seconds, coins, device_id, day')
      .eq('user_id', id)
      .order('started_at', { ascending: false })
      .limit(60),
    service.from('devices').select('device_id, first_seen, last_seen').eq('user_id', id)
  ])

  if (!profile.data) notFound()
  const person = profile.data

  const claimed = (intervals.data ?? []).reduce((sum, row) => sum + Number(row.claimed_seconds), 0)
  const qualifying = (intervals.data ?? []).reduce(
    (sum, row) => sum + Number(row.qualifying_seconds),
    0
  )
  const overclaimed = claimed - qualifying

  return (
    <main>
      <p className="note">
        <Link href="/collectors">← Collectors</Link>
      </p>
      <h1>{person.full_name || person.email || 'Collector'}</h1>
      <p className="lede">
        {person.email}
        {person.suspended && (
          <>
            {' '}
            <span className="pill rejected">suspended</span>
          </>
        )}
      </p>

      <div className="tiles">
        <div className="tile">
          <div className="k">Balance</div>
          <div className="v">
            {Number(balance.data?.total ?? 0).toLocaleString(undefined, {
              maximumFractionDigits: 2
            })}
          </div>
          <div className="sub">coins, from the ledger</div>
        </div>
        <div className="tile">
          <div className="k">Machines</div>
          <div className="v">{(devices.data ?? []).length}</div>
          <div className="sub">device ids seen</div>
        </div>
        <div className="tile">
          <div className="k">Over-claimed</div>
          <div className={overclaimed > 600 ? 'v warn' : 'v'}>
            {Math.round(overclaimed / 60).toLocaleString()}
          </div>
          <div className="sub">minutes asked for beyond the cap, last 60 stretches</div>
        </div>
        <div className="tile">
          <div className="k">Payable</div>
          <div className={person.wallet_address ? 'v small good' : 'v small warn'}>
            {person.wallet_address ? 'Wallet set' : person.profile_updated_at ? 'No wallet' : 'No details'}
          </div>
          <div className="sub">
            {person.profile_updated_at
              ? `details saved ${new Date(person.profile_updated_at).toLocaleDateString()}`
              : 'never filled in'}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <section className="group">
          <h2>Personal details</h2>
          <Detail label="Full name" value={person.full_name} />
          <Detail label="Date of birth" value={person.date_of_birth} />
          <Detail label="Email" value={person.email} note="from their Google sign-in" />
          <Detail label="Phone" value={person.phone} />
          <Detail
            label="Address"
            value={[
              person.address_line1,
              person.address_line2,
              person.city,
              person.region,
              person.postcode,
              person.country
            ]
              .filter((part) => (part ?? '') !== '')
              .join(', ')}
          />
        </section>

        <section className="group">
          <h2>Payout wallet</h2>
          <Detail label="Network" value={person.wallet_network} />
          <Detail label="Address" value={person.wallet_address} mono />
          <Detail
            label="Verified"
            value={person.wallet_verified_at ? 'yes' : 'no'}
            note="Nothing verifies wallet ownership yet. An address here is what the collector typed."
          />
          <div className="field">
            <div className="what">
              <span className="name">Account</span>
              <p className="why">
                A suspended account keeps reporting and earns nothing, and is not told why. Its
                history is kept, so an appeal can be judged.
              </p>
            </div>
            <div className="control">
              <SuspendButton id={person.id} suspended={person.suspended === true} />
            </div>
          </div>
        </section>
      </div>

      <h2>Ledger</h2>
      <p className="note" style={{ marginBottom: 12 }}>
        The last 60 stretches of qualifying time. <strong>Claimed</strong> is what the browser asked
        for; <strong>qualifying</strong> is what the daily cap allowed. A persistent gap between
        them is what an edited client looks like from here.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th className="num">Claimed</th>
              <th className="num">Qualifying</th>
              <th className="num">Coins</th>
              <th>Machine</th>
            </tr>
          </thead>
          <tbody>
            {(intervals.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="note">
                  Nothing banked yet.
                </td>
              </tr>
            ) : (
              (intervals.data ?? []).map((row, index) => (
                <tr key={`${row.started_at}-${index}`}>
                  <td className="note">{new Date(row.started_at).toLocaleString()}</td>
                  <td className="num">{Math.round(Number(row.claimed_seconds) / 60)}m</td>
                  <td className="num">{Math.round(Number(row.qualifying_seconds) / 60)}m</td>
                  <td className="num">{Number(row.coins).toFixed(2)}</td>
                  <td className="note" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {String(row.device_id).slice(0, 10)}…
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}

function Detail({
  label,
  value,
  note,
  mono = false
}: {
  label: string
  value: string | null | undefined
  note?: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="field">
      <div className="what">
        <span className="name">{label}</span>
        {note && <p className="why">{note}</p>}
      </div>
      <div className="control wide">
        <span
          style={{
            fontFamily: mono ? 'ui-monospace, monospace' : undefined,
            fontSize: mono ? 12 : 14,
            wordBreak: 'break-all',
            textAlign: 'right',
            color: (value ?? '') === '' ? 'var(--muted)' : undefined
          }}
        >
          {(value ?? '') === '' ? 'not given' : value}
        </span>
      </div>
    </div>
  )
}
