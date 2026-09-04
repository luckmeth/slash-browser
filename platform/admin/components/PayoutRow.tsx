'use client'

import { useActionState, useState } from 'react'
import { settlePayout, verifyWallet, type PayoutResult } from '@/app/payouts/actions'

/**
 * One payout request, and the three things an operator can do with it.
 *
 * The order on screen is the order the work happens in: check the wallet is
 * theirs, send the money, record what you sent. Marking one paid demands a
 * transaction reference, because a payout with no evidence of the transfer is
 * a payout that gets argued about later and cannot be settled either way.
 */
export function PayoutRow({
  request
}: {
  request: {
    id: string
    user_id: string
    coins: number
    amount_usd: number | null
    wallet_address: string
    wallet_network: string
    wallet_verified: boolean
    status: string
    requested_at: string
    tx_reference: string
    note: string
    email: string
    full_name: string
    signed: boolean
    verified_now: boolean
  }
}): React.JSX.Element {
  const [settleState, settle, settling] = useActionState<PayoutResult, FormData>(
    settlePayout,
    undefined
  )
  const [verifyState, verify, verifying] = useActionState<PayoutResult, FormData>(
    verifyWallet,
    undefined
  )
  const [decision, setDecision] = useState('')

  const open = request.status === 'requested' || request.status === 'approved'

  return (
    <div className="group">
      <div className="field">
        <div className="what">
          <span className="name">
            {request.full_name || request.email}{' '}
            <span className={`pill ${request.status}`}>{request.status}</span>
          </span>
          <p className="why">
            {Number(request.coins).toLocaleString()} coins
            {request.amount_usd !== null ? ` · $${Number(request.amount_usd).toFixed(2)}` : ' · no rate published when asked'}
            {' · asked '}
            {new Date(request.requested_at).toLocaleString()}
          </p>
          <p className="why" style={{ marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
            {request.wallet_network} · {request.wallet_address}
          </p>
        </div>

        <div className="control wide">
          {/* Verification first: it is the question that decides whether the
              rest of this row should happen at all. */}
          {request.verified_now ? (
            <span className="ok">wallet verified</span>
          ) : (
            <form action={verify}>
              <input type="hidden" name="userId" value={request.user_id} />
              <button type="submit" className="secondary" disabled={verifying || !request.signed}>
                {verifying ? 'Checking…' : request.signed ? 'Check the signature' : 'Not signed yet'}
              </button>
            </form>
          )}
          {verifyState && 'error' in verifyState && <div className="after bad">{verifyState.error}</div>}
          {verifyState && 'ok' in verifyState && <div className="ok">{verifyState.ok}</div>}
        </div>
      </div>

      {open && (
        <div className="field">
          <div className="what">
            <span className="name">Settle it</span>
            <p className="why">
              Nothing here sends money — there is no payment rail in this application. Send the
              transfer with your own wallet, then record the reference. Rejecting returns the coins
              to their balance in the same statement that changes the status.
              {!request.verified_now && (
                <>
                  {' '}
                  <strong>This wallet is not verified.</strong> Paying an address nobody has proven
                  is paying whoever typed last.
                </>
              )}
            </p>
          </div>

          <div className="control wide">
            <form action={settle}>
              <input type="hidden" name="id" value={request.id} />
              <select
                name="decision"
                value={decision}
                onChange={(event) => setDecision(event.target.value)}
              >
                <option value="">Choose…</option>
                <option value="approved">Approve — I am about to send it</option>
                <option value="paid">Paid — I have sent it</option>
                <option value="rejected">Reject — return the coins</option>
              </select>

              {decision === 'paid' && (
                <input
                  name="reference"
                  placeholder="Transaction hash or reference"
                  style={{ marginTop: 8 }}
                  required
                />
              )}
              {decision === 'rejected' && (
                <input name="note" placeholder="Why, in a sentence they can act on" style={{ marginTop: 8 }} required />
              )}

              <button type="submit" disabled={settling || decision === ''} style={{ marginTop: 8 }}>
                {settling ? 'Saving…' : 'Record it'}
              </button>
            </form>
            {settleState && 'error' in settleState && (
              <div className="after bad">{settleState.error}</div>
            )}
            {settleState && 'ok' in settleState && <div className="ok">{settleState.ok}</div>}
          </div>
        </div>
      )}

      {!open && (request.tx_reference !== '' || request.note !== '') && (
        <div className="field">
          <div className="what">
            <span className="name">Settled</span>
            <p className="why">
              {request.tx_reference !== '' ? `Reference: ${request.tx_reference}. ` : ''}
              {request.note}
            </p>
          </div>
          <div className="control" />
        </div>
      )}
    </div>
  )
}
