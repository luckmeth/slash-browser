'use server'

import { revalidatePath } from 'next/cache'
import { AUDIENCES, BROADCAST_CAP, footerFor, type Audience, type Recipient } from './audiences'
import { sendEmail } from '@/lib/email'
import { emailConfigured } from '@/lib/env'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

/**
 * Sending one message to a lot of people.
 *
 * This is the most irreversible thing in the application. A campaign can be
 * rejected, a price can be changed back, a suspension can be lifted; an email
 * that has been delivered is delivered. So the design is deliberately
 * unexciting:
 *
 * - **The audience is a named query, not a free-text list.** An operator picks
 *   who from a fixed set. Pasting addresses would make this a general-purpose
 *   sender, which is a different and much more dangerous tool.
 * - **Opt-outs are honoured here, in the query.** Not by remembering to filter
 *   in the screen. `email_opt_out` is set by the person in the browser, and
 *   the count shown to the operator is already the count after exclusion.
 * - **Every send is logged**, one row per recipient, by the same `sendEmail`
 *   that writes the transactional log. "Did they get it?" stays answerable.
 * - **It is capped.** A server action holding a socket open while it sends a
 *   thousand messages is a request that times out halfway with no record of
 *   where it stopped. A real bulk sender is a queue; this is honest about
 *   being a small one.
 */

/**
 * Who a send would reach, after opt-outs.
 *
 * Exported so the screen can show the count and a sample *before* anything is
 * sent, and so the count on the button is the same query that runs on send
 * rather than a number somebody typed into the copy.
 */
export async function audienceFor(audience: Audience): Promise<Recipient[]> {
  const service = supabaseService()
  const seen = new Set<string>()
  const out: Recipient[] = []

  const add = (email: unknown, name: unknown): void => {
    const address = String(email ?? '').trim().toLowerCase()
    if (address === '' || !address.includes('@') || seen.has(address)) return
    seen.add(address)
    out.push({ email: address, name: String(name ?? '') })
  }

  if (audience.startsWith('collectors')) {
    let query = service
      .from('profiles')
      .select('email, full_name, wallet_address, profile_updated_at, email_opt_out')
      .eq('email_opt_out', false)

    if (audience === 'collectors_no_wallet') query = query.eq('wallet_address', '')
    if (audience === 'collectors_complete') query = query.not('profile_updated_at', 'is', null)

    const { data } = await query
    for (const row of data ?? []) add(row.email, row.full_name)
    return out
  }

  let query = service.from('advertisers').select('contact_email, company_name, status')
  if (audience === 'advertisers_active') query = query.eq('status', 'active')

  const { data } = await query
  for (const row of data ?? []) add(row.contact_email, row.company_name)
  return out
}

export type BroadcastResult =
  | { error: string }
  | { ok: string; sent: number; failed: number }
  | undefined

/**
 * Sends it.
 *
 * The confirmation is the recipient count typed back by the operator. A
 * checkbox is dismissed without reading; a number has to be looked at, and it
 * is the one fact worth being sure of before pressing send. It is re-counted
 * here rather than trusted from the form, because the audience can have grown
 * between rendering the page and pressing the button — and "I confirmed 40"
 * must not become "it sent to 400".
 */
export async function sendBroadcast(
  _previous: BroadcastResult,
  formData: FormData
): Promise<BroadcastResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  if (!emailConfigured()) {
    return {
      error:
        'No email can be sent: the Resend key or the From address is not set. In Slash Operations ' +
        'they are under Setup → Database key and email delivery.'
    }
  }

  const audience = String(formData.get('audience') ?? '') as Audience
  const subject = String(formData.get('subject') ?? '').trim()
  const body = String(formData.get('body') ?? '').trim()
  const confirmed = String(formData.get('confirm') ?? '').trim()

  if (!AUDIENCES.some((entry) => entry.value === audience)) return { error: 'Choose an audience.' }
  if (subject === '') return { error: 'A subject is needed.' }
  if (subject.length > 160) return { error: 'That subject is too long for an inbox to show.' }
  if (body === '') return { error: 'The message is empty.' }

  const recipients = await audienceFor(audience)
  if (recipients.length === 0) return { error: 'That audience has nobody in it.' }

  if (confirmed !== String(recipients.length)) {
    return {
      error: `Type ${recipients.length} to confirm — that is how many people this reaches now.${
        confirmed === '' ? '' : ` You typed ${confirmed}.`
      }`
    }
  }

  if (recipients.length > BROADCAST_CAP) {
    return {
      error: `${recipients.length} is more than this sends in one go (${BROADCAST_CAP}). It sends one at a time from a single request, and a bigger list needs a queue rather than a longer wait.`
    }
  }

  let sent = 0
  let failed = 0
  const before = await countFailures()

  for (const recipient of recipients) {
    // Sequential on purpose: Resend rate-limits, and a burst that trips it
    // fails the tail of the list while looking successful at the top.
    await sendEmail({
      to: recipient.email,
      type: 'broadcast',
      subject,
      body: asHtml(body, recipient.name),
      footer: footerFor(audience)
    })
    sent += 1
  }

  failed = (await countFailures()) - before
  revalidatePath('/emails')

  return {
    ok:
      failed === 0
        ? `Sent to ${sent}. Every one is in the email log.`
        : `Attempted ${sent}; ${failed} failed. The reasons are in the email log.`,
    sent,
    failed
  }
}

/** Failures are counted from the log rather than tracked, since that is the record. */
async function countFailures(): Promise<number> {
  const { count } = await supabaseService()
    .from('email_log')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed')
  return count ?? 0
}

/**
 * Plain text to the same HTML frame the transactional messages use.
 *
 * Blank lines become paragraphs and nothing else is interpreted: an operator
 * typing a message is not writing markup, and letting them would mean an
 * unescaped `<` in a sentence about pricing breaking the layout for everyone
 * on the list.
 */
function asHtml(body: string, name: string): string {
  const greeting = name.trim() === '' ? '' : `<p>Hello ${escapeHtml(name.trim())},</p>`
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('')
  return greeting + paragraphs
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
