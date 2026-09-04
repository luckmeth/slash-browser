import { redirect } from 'next/navigation'
import { PayoutRow } from '@/components/PayoutRow'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * People asking to be paid.
 *
 * The queue exists because collecting a wallet address and never doing
 * anything with it is not a rewards scheme — it is a mailing list with extra
 * steps. Requests arrive from the browser, the coins are already deducted, and
 * this is where a person decides.
 *
 * Two things it shows that a list of amounts would not, and both change what
 * an operator does: whether the wallet has been **proven** to belong to the
 * person asking, and what rate the request was made at. The rate moves; what
 * somebody asked for does not.
 */
export default async function PayoutsPage(): Promise<React.JSX.Element> {
  if (!(await currentAdmin())) redirect('/login')

  const service = supabaseService()
  const { data, error } = await service
    .from('payout_requests')
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(200)

  if (error) {
    return (
      <main>
        <h1>Payouts</h1>
        <p className="banner">
          Could not read payout requests ({error.message}). If this mentions a missing table, apply{' '}
          <code>supabase/migrations/20260904_updates_and_payouts.sql</code>.
        </p>
      </main>
    )
  }

  const rows = data ?? []
  const people = await service
    .from('profiles')
    .select('id, email, full_name, wallet_signature, wallet_verified_at')
    .in('id', rows.length > 0 ? rows.map((row) => row.user_id) : ['00000000-0000-0000-0000-000000000000'])

  const byId = new Map((people.data ?? []).map((person) => [person.id, person]))

  const open = rows.filter((row) => row.status === 'requested' || row.status === 'approved')
  const owed = open.reduce((sum, row) => sum + Number(row.amount_usd ?? 0), 0)
  const coinsOpen = open.reduce((sum, row) => sum + Number(row.coins ?? 0), 0)

  return (
    <main>
      <h1>Payouts</h1>
      <p className="lede">
        Collectors asking to be paid. The coins were deducted when they asked, so nothing here can
        be claimed twice — and rejecting a request gives them back.
      </p>

      <div className="tiles">
        <div className="tile">
          <div className="k">Waiting</div>
          <div className={open.length > 0 ? 'v warn' : 'v'}>{open.length}</div>
          <div className="sub">{coinsOpen.toLocaleString()} coins held</div>
        </div>
        <div className="tile">
          <div className="k">Owed</div>
          <div className="v small">${owed.toFixed(2)}</div>
          <div className="sub">at the rate each was asked at</div>
        </div>
        <div className="tile">
          <div className="k">Paid</div>
          <div className="v">{rows.filter((row) => row.status === 'paid').length}</div>
          <div className="sub">all time</div>
        </div>
        <div className="tile">
          <div className="k">Rejected</div>
          <div className="v">{rows.filter((row) => row.status === 'rejected').length}</div>
          <div className="sub">coins returned</div>
        </div>
      </div>

      <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Nothing here sends money</h3>
        <p className="note">
          There is no payment rail in this application, and one is not simulated. Send the transfer
          with your own wallet software, then record the reference here — that reference is the only
          evidence the transfer happened, and it is what a dispute months later points at.
        </p>
        <p className="note">
          Check the wallet first. Slash can verify an Ethereum, Polygon or BNB Smart Chain signature
          against the address on the account; for any other chain it says so rather than implying it
          looked.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="note">Nobody has asked for a payout yet.</p>
      ) : (
        <div className="stack">
          {rows.map((row) => {
            const person = byId.get(row.user_id)
            return (
              <PayoutRow
                key={row.id}
                request={{
                  id: row.id,
                  user_id: row.user_id,
                  coins: Number(row.coins),
                  amount_usd: row.amount_usd === null ? null : Number(row.amount_usd),
                  wallet_address: String(row.wallet_address ?? ''),
                  wallet_network: String(row.wallet_network ?? ''),
                  wallet_verified: row.wallet_verified === true,
                  status: String(row.status),
                  requested_at: String(row.requested_at),
                  tx_reference: String(row.tx_reference ?? ''),
                  note: String(row.note ?? ''),
                  email: String(person?.email ?? ''),
                  full_name: String(person?.full_name ?? ''),
                  signed: String(person?.wallet_signature ?? '') !== '',
                  // What is true now, rather than what was true when they
                  // asked: a wallet verified since the request is verified.
                  verified_now: person?.wallet_verified_at !== null && person?.wallet_verified_at !== undefined
                }}
              />
            )
          })}
        </div>
      )}
    </main>
  )
}
