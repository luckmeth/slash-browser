import { useState } from 'react'
import type { CoinProfile } from '@shared/types/rewards'
import { Icon } from '../../components/Icon'

/**
 * Asking to be paid, and proving the wallet first.
 *
 * The order on screen is the order that makes sense: prove the address is
 * yours, then ask. An unproven address is not refused — an operator can still
 * decide — but the screen says plainly that it will slow the request down,
 * because a payout to an address nobody proved is a payout to whoever typed
 * last, and that is a thing worth saying before somebody waits a week.
 *
 * Three facts stated where they matter rather than in terms nobody opens:
 * requesting **deducts** the coins immediately, a refusal **returns** them,
 * and the rate is fixed at the moment of asking rather than the moment of
 * paying.
 */
export function PayoutCard({
  profile,
  balance,
  coinToUsd,
  onChanged
}: {
  profile: CoinProfile
  balance: number
  coinToUsd: number | null
  onChanged: () => void
}): React.JSX.Element {
  const [coins, setCoins] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [challenge, setChallenge] = useState(profile.walletChallenge)
  const [signature, setSignature] = useState('')
  const [signingOpen, setSigningOpen] = useState(false)
  const [said, setSaid] = useState('')

  const payout = profile.payout
  const open = payout !== null && (payout.status === 'requested' || payout.status === 'approved')
  const asking = Number(coins)
  const worth = coinToUsd !== null && Number.isFinite(asking) ? asking * coinToUsd : null

  const act = <T,>(promise: Promise<T>, after: (value: T) => void): void => {
    setBusy(true)
    setProblem('')
    setSaid('')
    void promise
      .then(after)
      .finally(() => setBusy(false))
  }

  return (
    <section className="slash-reveal glass-raised mt-3 rounded-2xl border border-[var(--glass-edge)] p-5">
      <div className="flex items-center gap-2">
        <Icon name="star" size={15} />
        <h2 className="text-[13.5px] font-medium">Getting paid</h2>
      </div>

      {profile.walletAddress === '' ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
          Add a payout wallet in your details above, and this is where you ask to be paid into it.
        </p>
      ) : (
        <>
          {/* Proof first: it is the question that decides how fast a request
              can be settled. */}
          <div className="mt-3 rounded-xl border border-[var(--glass-edge)] bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[12.5px] font-medium">
                  {profile.walletVerified
                    ? 'Wallet verified'
                    : profile.walletSigned
                      ? 'Signature sent — waiting to be checked'
                      : 'Wallet not verified'}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                  {profile.walletVerified
                    ? 'A signature from this address has been checked against your account.'
                    : 'Proving the address is yours means signing a short message with the wallet that owns it. Without that, a payout waits for a person to check it by hand.'}
                </p>
              </div>
              {!profile.walletVerified && !signingOpen && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(window.browser.invoke('rewards:walletChallenge', undefined), (result) => {
                      if (!result.ok) {
                        setProblem('Could not reach the rewards service.')
                        return
                      }
                      if (!result.value.ok) {
                        setProblem(result.value.problem)
                        return
                      }
                      setChallenge(result.value.challenge)
                      setSigningOpen(true)
                    })
                  }
                  className="shrink-0 cursor-default rounded-lg border border-[var(--glass-edge)] px-3 py-1.5 text-[11.5px] transition hover:border-[var(--color-accent)]"
                >
                  Prove it
                </button>
              )}
            </div>

            {signingOpen && challenge !== '' && (
              <div className="mt-3">
                <p className="text-[11.5px] text-[var(--color-text-muted)]">
                  Sign this exact text in your wallet — in MetaMask, <em>Sign message</em> — then
                  paste the signature back here. Slash never asks for a private key or a seed
                  phrase, and nothing that asks you for one is us.
                </p>
                <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--color-text-muted)]">
                  {challenge}
                </pre>
                <input
                  value={signature}
                  onChange={(event) => setSignature(event.target.value)}
                  placeholder="0x… the signature your wallet produced"
                  spellCheck={false}
                  className="mt-2 w-full rounded-lg border border-[var(--glass-edge)] bg-white/[0.04] px-3 py-2 font-mono text-[11.5px] outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="button"
                  disabled={busy || signature.trim() === ''}
                  onClick={() =>
                    act(
                      window.browser.invoke('rewards:submitWalletSignature', { signature }),
                      (result) => {
                        if (!result.ok || !result.value.ok) {
                          setProblem(result.ok ? result.value.problem : 'Could not reach the service.')
                          return
                        }
                        setSigningOpen(false)
                        setSaid('Signature sent. Slash checks it before your next payout.')
                        onChanged()
                      }
                    )
                  }
                  className="mt-2 cursor-default rounded-lg bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-black disabled:opacity-40"
                >
                  Send the signature
                </button>
              </div>
            )}
          </div>

          {open ? (
            <div className="mt-3 rounded-xl border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/8 p-4">
              <p className="text-[12.5px]">
                A payout of{' '}
                <strong>{payout.coins.toLocaleString()} coins</strong>
                {payout.amountUsd !== null ? ` ($${payout.amountUsd.toFixed(2)})` : ''} is{' '}
                {payout.status === 'approved' ? 'approved and being sent' : 'waiting to be looked at'}
                .
              </p>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                Those coins have already left your balance. If it is refused they come back in full,
                with a reason.
              </p>
            </div>
          ) : (
            <div className="mt-3">
              <label className="mb-1.5 block text-[11.5px] text-[var(--color-text-muted)]">
                How many coins to cash in — you have {balance.toLocaleString()}
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={coins}
                  min={0}
                  onChange={(event) => setCoins(event.target.value)}
                  placeholder="1000 minimum"
                  className="w-full rounded-lg border border-[var(--glass-edge)] bg-white/[0.04] px-3 py-2 text-[13px] tabular-nums outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="button"
                  disabled={busy || !(asking > 0)}
                  onClick={() =>
                    act(window.browser.invoke('rewards:requestPayout', { coins: asking }), (result) => {
                      if (!result.ok) {
                        setProblem('Could not reach the rewards service.')
                        return
                      }
                      if (!result.value.ok) {
                        setProblem(result.value.problem)
                        return
                      }
                      setCoins('')
                      setSaid('Asked. A person settles it, and you will see it here either way.')
                      onChanged()
                    })
                  }
                  className="shrink-0 cursor-default rounded-lg bg-[var(--color-accent)] px-4 py-2 text-[12.5px] font-semibold text-black disabled:opacity-40"
                >
                  Ask to be paid
                </button>
              </div>

              <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                {worth !== null && asking > 0
                  ? `About $${worth.toFixed(2)} at the published rate. `
                  : 'No value has been published yet, so a request records the coins and no amount. '}
                The rate is fixed when you ask, not when it is paid. Requesting takes the coins out
                of your balance immediately so they cannot be claimed twice; a refusal returns them.
                Network fees come out of what is sent.
              </p>
            </div>
          )}
        </>
      )}

      {problem !== '' && <p className="mt-3 text-[12px] text-[var(--color-bad)]">{problem}</p>}
      {said !== '' && <p className="mt-3 text-[12px] text-[var(--color-good)]">{said}</p>}
    </section>
  )
}
