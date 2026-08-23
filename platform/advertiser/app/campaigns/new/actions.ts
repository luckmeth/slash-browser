'use server'

import { embedded } from '@slash/ad-shared'
import { supabaseServer } from '@/lib/supabase/server'
import { emails, sendEmail } from '@/lib/email'

/**
 * Acknowledges a submitted campaign.
 *
 * A server action rather than something the builder does directly, because
 * sending email needs a key that must never reach a browser. It reads the
 * campaign back under the caller's own session, so this cannot be used to make
 * us email somebody about a campaign that is not theirs.
 *
 * Best-effort: a campaign is submitted whether or not the acknowledgement gets
 * out, and `email_log` records the failure either way.
 */
export async function notifySubmitted(campaignId: string): Promise<void> {
  const supabase = await supabaseServer()
  const { data } = await supabase
    .from('campaigns')
    .select('id, title, advertisers ( contact_email )')
    .eq('id', campaignId)
    .maybeSingle()

  const to = embedded<{ contact_email: string }>(data?.advertisers)?.contact_email
  if (!data || !to) return

  await sendEmail({ to, campaignId: data.id, ...emails.campaignReceived(data.title) })
}
