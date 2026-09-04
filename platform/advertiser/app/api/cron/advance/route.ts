import { NextResponse } from 'next/server'
import { embedded } from '@slash/ad-shared'
import { supabaseService } from '@/lib/supabase/service'
import { env } from '@/lib/env'
import { emails, sendEmail } from '@/lib/email'

/**
 * Moves campaigns across their own start and end lines.
 *
 * **Nothing else does this.** Without a schedule calling it, a paid and
 * approved campaign stays `scheduled` for ever, is never marked `active`, and —
 * worse — is never marked `completed`, so it keeps being served long after the
 * hours somebody bought have run out. Set it up before taking a real payment;
 * `platform/README.md` has the cron entry.
 *
 * Safe to run as often as you like. `advance_campaign_states()` returns only
 * the campaigns it actually moved, so a run with nothing to do emails nobody.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  // A shared secret, because the endpoint changes state and sends email. Vercel
  // Cron sends it as a bearer token; anything else can pass it as a query
  // parameter. Unset means the endpoint refuses to run at all rather than
  // running for anyone who finds the URL.
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 503 })
  }
  const url = new URL(request.url)
  const offered =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('key')
  if (offered !== env.CRON_SECRET) {
    return NextResponse.json({ error: 'not authorised' }, { status: 401 })
  }

  const supabase = supabaseService()

  const { data: moved, error } = await supabase.rpc('advance_campaign_states')
  if (error) {
    console.error('could not advance campaign states', error)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }

  const started = (moved ?? []).filter(
    (row: { new_status: string }) => row.new_status === 'active'
  )

  // One "your advert is live" note per campaign that genuinely just went live.
  for (const row of started as { id: string }[]) {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, title, ends_at, advertisers ( contact_email )')
      .eq('id', row.id)
      .maybeSingle()

    const to = embedded<{ contact_email: string }>(campaign?.advertisers)?.contact_email
    if (campaign && to) {
      await sendEmail({
        to,
        campaignId: campaign.id,
        ...emails.adLive(campaign.title, new Date(campaign.ends_at).toUTCString())
      })
    }
  }

  const reminded = await remindEndingSoon()

  return NextResponse.json({
    moved: moved?.length ?? 0,
    started: started.length,
    reminded
  })
}

/**
 * Nudges campaigns finishing within a day.
 *
 * Guarded on `email_log` rather than a column on the campaign: the log already
 * records every send, so asking it "have we told them?" needs no extra state
 * and cannot drift out of step with what was actually sent.
 */
async function remindEndingSoon(): Promise<number> {
  const supabase = supabaseService()
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  const { data: ending } = await supabase
    .from('campaigns')
    .select('id, title, ends_at, advertisers ( contact_email )')
    .eq('status', 'active')
    .lt('ends_at', soon)
    .gt('ends_at', new Date().toISOString())

  let sent = 0
  for (const campaign of ending ?? []) {
    const { count } = await supabase
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('type', 'ending_soon')

    if ((count ?? 0) > 0) continue

    const to = embedded<{ contact_email: string }>(campaign.advertisers)?.contact_email
    if (!to) continue

    await sendEmail({
      to,
      campaignId: campaign.id,
      ...emails.endingSoon(campaign.title, new Date(campaign.ends_at).toUTCString())
    })
    sent += 1
  }
  return sent
}
