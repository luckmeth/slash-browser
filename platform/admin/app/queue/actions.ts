'use server'

import { revalidatePath } from 'next/cache'
import { embedded, formatCents } from '@slash/ad-shared'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { stripe } from '@/lib/stripe'
import { paymentsConfigured } from '@/lib/env'
import { emails, sendEmail } from '@/lib/email'

/**
 * Approving and rejecting campaigns.
 *
 * Both re-check operator membership themselves. A server action is a POST
 * endpoint with a generated name — reachable by anyone who finds it — so
 * "only operators see the button" is not a check, it is a layout decision.
 */

export type Decision = { error: string } | { ok: string } | undefined

async function requireAdmin(): Promise<void> {
  const admin = await currentAdmin()
  if (!admin) throw new Error('not an operator')
}

export async function approve(_prev: Decision, formData: FormData): Promise<Decision> {
  await requireAdmin()
  const id = String(formData.get('campaignId') ?? '')
  const supabase = supabaseService()

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, placement_tier, starts_at, ends_at, status')
    .eq('id', id)
    .maybeSingle()

  if (!campaign) return { error: 'That campaign no longer exists.' }
  if (campaign.status !== 'pending_review') {
    return { error: `That campaign is ${campaign.status}, not waiting for review.` }
  }

  // Capacity is re-checked at approval as well as at checkout. Time passes
  // between the two, and approving past the cap makes the batch bigger for
  // every reader — including the ones whose adverts are not in it.
  const [{ data: peak }, { data: tier }] = await Promise.all([
    supabase.rpc('tier_peak_load', {
      tier: campaign.placement_tier,
      window_start: campaign.starts_at,
      window_end: campaign.ends_at,
      ignore_campaign: campaign.id
    }),
    supabase
      .from('pricing_config')
      .select('max_concurrent, display_name')
      .eq('placement_tier', campaign.placement_tier)
      .maybeSingle()
  ])

  if (tier && typeof peak === 'number' && peak >= tier.max_concurrent) {
    return {
      error:
        `Approving this would put ${tier.display_name} over its limit of ` +
        `${tier.max_concurrent} at once for part of the window. Raise the cap in Pricing, ` +
        'or reject and refund.'
    }
  }

  const { data: approved, error } = await supabase
    .from('campaigns')
    .update({ status: 'approved_unpaid', review_note: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending_review')
    .select('id, title, total_cost, starts_at, advertisers ( contact_email )')
    .maybeSingle()

  if (error) return { error: error.message }

  // They cannot pay until they know they may. This email is the only thing
  // that tells them.
  const to = embedded<{ contact_email: string }>(approved?.advertisers)?.contact_email
  if (approved && to) {
    await sendEmail({
      to,
      campaignId: approved.id,
      ...emails.approvedPayNow(
        approved.title,
        formatCents(Math.round(Number(approved.total_cost) * 100)),
        new Date(approved.starts_at).toUTCString()
      )
    })
  }

  revalidatePath('/queue')
  return { ok: 'Approved. They have been emailed and can now pay.' }
}

export async function reject(_prev: Decision, formData: FormData): Promise<Decision> {
  await requireAdmin()
  const id = String(formData.get('campaignId') ?? '')
  const note = String(formData.get('note') ?? '').trim().slice(0, 300)

  if (note === '') {
    // A rejection with no reason is one the advertiser cannot act on, so they
    // resubmit the same thing and it lands back in this queue.
    return { error: 'Give a reason — it is emailed to the advertiser.' }
  }

  const supabase = supabaseService()

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, title, status, advertisers ( contact_email )')
    .eq('id', id)
    .maybeSingle()

  if (!campaign) return { error: 'That campaign no longer exists.' }

  // Usually there is nothing to give back: review now happens before payment,
  // so a rejected campaign was never charged. The refund path stays for rows
  // created under the old order, and because an operator may still reject
  // something already running.
  const refund = await refundFor(id)
  if (refund.attempted && !refund.ok) {
    return {
      error:
        `Not rejected: the refund failed (${refund.error}). ` +
        'Refund it in Stripe first, then reject here.'
    }
  }

  const { error } = await supabase
    .from('campaigns')
    .update({ status: 'rejected', review_note: note, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return { error: error.message }

  const to = embedded<{ contact_email: string }>(campaign.advertisers)?.contact_email
  if (to) {
    await sendEmail({ to, campaignId: id, ...emails.rejection(campaign.title, note) })
  }

  revalidatePath('/queue')
  return {
    ok: refund.attempted
      ? 'Rejected and refunded. The advertiser has been emailed.'
      : 'Rejected. Nothing had been paid, so there was nothing to refund.'
  }
}

/**
 * Refunds the succeeded payment for a campaign, if there is one.
 *
 * `attempted: false` means there was no money to return — an unpaid campaign
 * being rejected, which is a normal thing and not a failure.
 */
async function refundFor(
  campaignId: string
): Promise<{ attempted: boolean; ok: boolean; error?: string }> {
  const supabase = supabaseService()
  const { data: payment } = await supabase
    .from('payments')
    .select('id, stripe_payment_intent_id, status')
    .eq('campaign_id', campaignId)
    .eq('status', 'succeeded')
    .maybeSingle()

  if (!payment?.stripe_payment_intent_id) return { attempted: false, ok: true }
  if (!paymentsConfigured()) {
    return { attempted: true, ok: false, error: 'Stripe is not configured on this deployment' }
  }

  try {
    await stripe().refunds.create({ payment_intent: payment.stripe_payment_intent_id })
    // The charge.refunded webhook also sets this. Writing it here as well means
    // the operator sees the right thing immediately rather than after Stripe
    // gets round to calling back.
    await supabase.from('payments').update({ status: 'refunded' }).eq('id', payment.id)
    return { attempted: true, ok: true }
  } catch (cause) {
    return {
      attempted: true,
      ok: false,
      error: cause instanceof Error ? cause.message : 'unknown error'
    }
  }
}
