import { NextResponse } from 'next/server'
import { z } from 'zod'
import { formatCents } from '@slash/ad-shared'
import { supabaseServer } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { stripe } from '@/lib/stripe'
import { env, paymentsConfigured } from '@/lib/env'

/**
 * Starts a Stripe Checkout session for one campaign.
 *
 * The amount is read from the campaign row, which was written by the pricing
 * trigger — not from the request. A price that arrives from a browser is a
 * price somebody can edit, and this is the exact request they would edit.
 */

export const dynamic = 'force-dynamic'

const Body = z.object({ campaignId: z.string().uuid() })

export async function POST(request: Request): Promise<NextResponse> {
  if (!paymentsConfigured()) {
    return NextResponse.json(
      { error: 'Payments are not configured on this deployment yet.' },
      { status: 503 }
    )
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Which campaign?' }, { status: 400 })
  }

  // Read as the signed-in advertiser, under RLS. Someone else's campaign id
  // simply returns nothing here — the check is the database's, not this file's.
  const supabase = await supabaseServer()
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, title, status, total_cost, total_hours, placement_tier, starts_at, ends_at, advertiser_id')
    .eq('id', parsed.data.campaignId)
    .maybeSingle()

  if (!campaign) {
    return NextResponse.json({ error: 'That campaign was not found.' }, { status: 404 })
  }
  if (campaign.status !== 'pending_payment') {
    return NextResponse.json(
      { error: 'That campaign has already been paid for.' },
      { status: 409 }
    )
  }

  const amountCents = Math.round(Number(campaign.total_cost) * 100)
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: 'That campaign has no price yet.' }, { status: 409 })
  }

  // Capacity is checked here, immediately before taking money, rather than at
  // submission. Two people can fill the last slot between filling in a form and
  // reaching checkout, and the one who finds out should find out before paying.
  const service = supabaseService()
  const { data: peak } = await service.rpc('tier_peak_load', {
    tier: campaign.placement_tier,
    window_start: campaign.starts_at,
    window_end: campaign.ends_at,
    ignore_campaign: campaign.id
  })
  const { data: tier } = await service
    .from('pricing_config')
    .select('max_concurrent, display_name')
    .eq('placement_tier', campaign.placement_tier)
    .maybeSingle()

  if (tier && typeof peak === 'number' && peak >= tier.max_concurrent) {
    return NextResponse.json(
      {
        error:
          `${tier.display_name} is fully booked for part of that window. ` +
          'Pick different dates and try again — you have not been charged.'
      },
      { status: 409 }
    )
  }

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    success_url: `${env.NEXT_PUBLIC_SITE_URL}/dashboard?paid=${campaign.id}`,
    cancel_url: `${env.NEXT_PUBLIC_SITE_URL}/dashboard`,
    client_reference_id: campaign.id,
    // Read back in the webhook. The webhook trusts this rather than anything in
    // the redirect, because the redirect is a URL the buyer's browser follows
    // and can therefore be forged; a signed webhook cannot.
    metadata: { campaign_id: campaign.id, advertiser_id: campaign.advertiser_id },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: campaign.title,
            description: `${campaign.total_hours} hours · ${formatCents(amountCents)} total`
          }
        }
      }
    ]
  })

  // Recorded as pending now, so a payment that succeeds while the webhook is
  // briefly unreachable still has a row to attach itself to.
  await service.from('payments').insert({
    campaign_id: campaign.id,
    advertiser_id: campaign.advertiser_id,
    amount: campaign.total_cost,
    currency: 'usd',
    stripe_checkout_session: session.id,
    status: 'pending'
  })

  return NextResponse.json({ url: session.url })
}
