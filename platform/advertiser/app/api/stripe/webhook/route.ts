import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { embedded, formatCents } from '@slash/ad-shared'
import { supabaseService } from '@/lib/supabase/service'
import { stripe } from '@/lib/stripe'
import { env, paymentsConfigured } from '@/lib/env'
import { emails, sendEmail } from '@/lib/email'

/**
 * Stripe's signed notification that money actually moved.
 *
 * **This, and only this, is what marks a campaign paid.** The success redirect
 * is a URL the buyer's own browser follows — anybody can visit it, with any
 * campaign id — so treating it as proof of payment would mean giving away
 * adverts to whoever guessed the link. The signature check below is the whole
 * reason this endpoint exists separately from that redirect.
 */

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  if (!paymentsConfigured()) {
    return NextResponse.json({ error: 'payments not configured' }, { status: 503 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'unsigned' }, { status: 400 })
  }

  // The raw body, byte for byte. Parsing it first and re-serialising would
  // change the bytes and the signature would never verify again.
  const raw = await request.text()

  let event: Stripe.Event
  try {
    event = stripe().webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET!)
  } catch (cause) {
    console.error('rejected a webhook with a bad signature', cause)
    return NextResponse.json({ error: 'bad signature' }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await fulfil(event.data.object)
    } else if (event.type === 'charge.refunded') {
      await markRefunded(event.data.object)
    }
  } catch (cause) {
    console.error(`could not handle ${event.type}`, cause)
    // 500 so Stripe retries. Swallowing this would mean a campaign somebody
    // paid for silently never running.
    return NextResponse.json({ error: 'handler failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

async function fulfil(session: Stripe.Checkout.Session): Promise<void> {
  const campaignId = session.metadata?.campaign_id
  if (!campaignId) {
    console.warn('a completed checkout session carried no campaign id')
    return
  }
  if (session.payment_status !== 'paid') return

  const supabase = supabaseService()

  // Stripe delivers a webhook at least once, and sometimes more than once.
  // Deciding on the payment row's current status makes a repeat delivery a
  // no-op instead of a second email and a second state change.
  const { data: payment } = await supabase
    .from('payments')
    .select('id, status')
    .eq('stripe_checkout_session', session.id)
    .maybeSingle()

  if (payment?.status === 'succeeded') return

  await supabase
    .from('payments')
    .update({
      status: 'succeeded',
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id:
        typeof session.payment_intent === 'string' ? session.payment_intent : null
    })
    .eq('stripe_checkout_session', session.id)

  // Already approved by a person before it could be paid for, so payment is the
  // last gate. It now waits only for its start time.
  const { data: campaign } = await supabase
    .from('campaigns')
    .update({ status: 'scheduled', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('status', 'approved_unpaid')
    .select('id, title, starts_at, total_cost, advertisers ( contact_email )')
    .maybeSingle()

  if (!campaign) return

  const to = embedded<{ contact_email: string }>(campaign.advertisers)?.contact_email
  if (to) {
    const message = emails.paymentConfirmation(
      campaign.title,
      formatCents(Math.round(Number(campaign.total_cost) * 100)),
      new Date(campaign.starts_at).toUTCString()
    )
    await sendEmail({ to, campaignId: campaign.id, ...message })
  }
}

async function markRefunded(charge: Stripe.Charge): Promise<void> {
  const intent = typeof charge.payment_intent === 'string' ? charge.payment_intent : null
  if (!intent) return
  await supabaseService()
    .from('payments')
    .update({ status: 'refunded' })
    .eq('stripe_payment_intent_id', intent)
}
