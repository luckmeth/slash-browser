'use server'

import { revalidatePath } from 'next/cache'
import { verifyWalletProof } from '@slash/ad-shared'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export type PayoutResult = { error: string } | { ok: string } | undefined

/**
 * Settling a payout request.
 *
 * The money is not moved here — there is no payment rail in this project, and
 * pretending there is would be the dishonest option. An operator sends the
 * transfer with whatever wallet software they use and records the reference,
 * which is what a dispute later points at.
 *
 * Rejecting **returns the coins**. They were deducted when the request was
 * made so a balance could not be claimed twice, and a refusal that keeps them
 * is theft by bookkeeping. That happens inside `settle_payout`, in the same
 * statement that changes the status, so the two cannot come apart.
 */
export async function settlePayout(
  _previous: PayoutResult,
  formData: FormData
): Promise<PayoutResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  const id = String(formData.get('id') ?? '')
  const decision = String(formData.get('decision') ?? '')
  const reference = String(formData.get('reference') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim()

  if (!['approved', 'paid', 'rejected'].includes(decision)) {
    return { error: 'Choose approve, paid or reject.' }
  }
  if (decision === 'paid' && reference === '') {
    return {
      error:
        'A transaction reference is needed to mark one paid. It is the only evidence that the transfer happened.'
    }
  }
  if (decision === 'rejected' && note === '') {
    return { error: 'Say why. A refusal somebody cannot act on is worse than a delay.' }
  }

  const { error } = await supabaseService().rpc('settle_payout', {
    request_id: id,
    decision,
    reference,
    why: note
  })

  if (error) {
    if (/settle_payout|PGRST202/i.test(error.message)) {
      return {
        error:
          'This deployment is missing settle_payout. Apply supabase/migrations/20260904_updates_and_payouts.sql.'
      }
    }
    return { error: error.message }
  }

  revalidatePath('/payouts')
  revalidatePath('/collectors')
  return {
    ok:
      decision === 'rejected'
        ? 'Rejected, and the coins have gone back to their balance.'
        : decision === 'paid'
          ? 'Marked paid, with the reference recorded.'
          : 'Approved. Send it, then come back and mark it paid.'
  }
}

/**
 * Checks that the wallet on an account is controlled by whoever asked to be
 * paid into it.
 *
 * Server-side, and only here. A browser that marked its own wallet verified
 * would be proving nothing at all, and Postgres cannot do secp256k1 recovery —
 * so the collector signs a challenge in their wallet, the signature is stored,
 * and this recovers the signing address and compares it.
 *
 * Ethereum, Polygon and BNB Smart Chain only. The others are reported as
 * unsupported rather than being waved through, because "we did not look" and
 * "it checks out" lead an operator to different decisions.
 */
export async function verifyWallet(
  _previous: PayoutResult,
  formData: FormData
): Promise<PayoutResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  const userId = String(formData.get('userId') ?? '')
  const service = supabaseService()

  const { data, error } = await service
    .from('profiles')
    .select('wallet_address, wallet_network, wallet_challenge, wallet_signature')
    .eq('id', userId)
    .maybeSingle()

  if (error) return { error: error.message }
  if (!data) return { error: 'No such collector.' }
  if ((data.wallet_signature ?? '') === '') {
    return { error: 'They have not signed the challenge yet, so there is nothing to check.' }
  }

  const verdict = verifyWalletProof(
    String(data.wallet_network ?? ''),
    String(data.wallet_address ?? ''),
    String(data.wallet_challenge ?? ''),
    String(data.wallet_signature ?? '')
  )

  if (!verdict.ok) {
    // A failed check clears any previous verification: whatever was true
    // before, it is not true of this signature and this address.
    await service.from('profiles').update({ wallet_verified_at: null }).eq('id', userId)
    revalidatePath('/payouts')
    return { error: verdict.reason }
  }

  const { error: saveError } = await service
    .from('profiles')
    .update({ wallet_verified_at: new Date().toISOString() })
    .eq('id', userId)

  if (saveError) return { error: saveError.message }

  revalidatePath('/payouts')
  revalidatePath(`/collectors/${userId}`)
  return { ok: `Verified. ${verdict.address} signed the challenge, and it matches the account.` }
}
