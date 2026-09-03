import 'server-only'
import { Resend } from 'resend'
import { emailConfigured, env } from './env'
import { supabaseService } from './supabase/service'

/**
 * Transactional email, and a record of every attempt.
 *
 * Every send is logged to `email_log` — including failures, with the reason.
 * "Did they get the receipt?" is otherwise unanswerable, and the first time
 * anyone asks is when somebody says they were charged without being told.
 *
 * Sending is best-effort by design: a campaign that has been paid for must go
 * live whether or not Resend is reachable. Nothing here ever throws into a
 * payment path.
 */

export type EmailType =
  | 'welcome'
  | 'campaign_received'
  | 'approved_pay_now'
  | 'payment_confirmation'
  | 'ad_live'
  | 'rejection'
  | 'ending_soon'
  // An operator message to a list, rather than a message caused by one
  // campaign. Logged like everything else, so a broadcast is answerable the
  // same way a receipt is.
  | 'broadcast'

interface SendArgs {
  to: string
  type: EmailType
  subject: string
  body: string
  campaignId?: string
  /**
   * Why this person is receiving it.
   *
   * Defaults to the advertiser wording, which is what every message here was
   * until collectors existed. A broadcast to people collecting Slash Coin that
   * tells them they have an advertiser account is wrong in the one line of an
   * email whose whole job is to be trustworthy.
   */
  footer?: string
}

const ADVERTISER_FOOTER = 'You are receiving this because you have an advertiser account.'

const wrap = (title: string, body: string, footer: string = ADVERTISER_FOOTER): string => `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;
            margin:0 auto;padding:24px;color:#1b1f27;line-height:1.55">
  <h1 style="font-size:19px;margin:0 0 14px">${escapeHtml(title)}</h1>
  ${body}
  <p style="margin-top:28px;font-size:12px;color:#6b7280">
    Slash. ${escapeHtml(footer)}
  </p>
</div>`

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export async function sendEmail({
  to,
  type,
  subject,
  body,
  campaignId,
  footer
}: SendArgs): Promise<void> {
  let status: 'sent' | 'failed' = 'sent'
  let error: string | null = null

  if (!emailConfigured()) {
    status = 'failed'
    error = 'RESEND_API_KEY or EMAIL_FROM is not set'
  } else {
    try {
      const resend = new Resend(env.RESEND_API_KEY)
      const result = await resend.emails.send({
        from: env.EMAIL_FROM!,
        to,
        subject,
        html: wrap(subject, body, footer)
      })
      if (result.error) {
        status = 'failed'
        error = result.error.message
      }
    } catch (cause) {
      status = 'failed'
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  // The log is written whatever happened, and its own failure is swallowed:
  // an unreachable database must not turn a delivered email into a thrown
  // request, nor stop a paid campaign going live.
  try {
    await supabaseService()
      .from('email_log')
      .insert({ type, recipient: to, campaign_id: campaignId ?? null, status, error })
  } catch {
    /* nothing useful to do here, and nothing worth failing a payment over */
  }
}

// ---------------------------------------------------------------------------
// The five messages, in one place so their wording can be read together
// ---------------------------------------------------------------------------

export const emails = {
  welcome: (company: string) => ({
    type: 'welcome' as const,
    subject: 'Your Slash advertiser account',
    body: `<p>Welcome, ${escapeHtml(company)}.</p>
      <p>You can submit a campaign whenever you like. Three things worth knowing
      before you do:</p>
      <ul>
        <li>Adverts are bought by the hour, with a minimum block per placement.</li>
        <li>Images are uploaded, never linked. Your creative is delivered with the
            advert to each reader's own machine, so showing it never calls your server
            — and never tells us who saw it.</li>
        <li>There is no targeting. We can tell you how many times your advert was
            shown and clicked, per day, and genuinely nothing else.</li>
      </ul>`
  }),

  campaignReceived: (title: string) => ({
    type: 'campaign_received' as const,
    subject: `We have your campaign — ${title}`,
    body: `<p><strong>${escapeHtml(title)}</strong> is with us for review.</p>
      <p>Somebody looks at every campaign before it runs. You will hear from us either way, and
      you have not been charged — payment comes after approval, so there is never money sitting
      with us for something we then turn down.</p>`
  }),

  approvedPayNow: (title: string, amount: string, starts: string) => ({
    type: 'approved_pay_now' as const,
    subject: `${title} is approved — pay to go live`,
    body: `<p><strong>${escapeHtml(title)}</strong> has been approved.</p>
      <p>Pay ${escapeHtml(amount)} from your dashboard and it will start
      ${escapeHtml(starts)}. Until then the slot is held for you.</p>`
  }),

  paymentConfirmation: (title: string, amount: string, starts: string) => ({
    type: 'payment_confirmation' as const,
    subject: `Payment received — ${title}`,
    body: `<p>We have received ${escapeHtml(amount)} for <strong>${escapeHtml(title)}</strong>.</p>
      <p>It is scheduled to start ${escapeHtml(starts)}. You will get one more note
      when it actually goes live.</p>`
  }),

  adLive: (title: string, ends: string) => ({
    type: 'ad_live' as const,
    subject: `${title} is now live`,
    body: `<p><strong>${escapeHtml(title)}</strong> is now showing on the Slash start page.</p>
      <p>It runs until ${escapeHtml(ends)}. Delivery figures appear on your dashboard
      within a few hours — they arrive in batches, so they lag a little and are
      indicative rather than exact.</p>`
  }),

  rejection: (title: string, reason: string) => ({
    type: 'rejection' as const,
    subject: `${title} was not approved`,
    body: `<p><strong>${escapeHtml(title)}</strong> has not been approved.</p>
      <p>${escapeHtml(reason || 'No reason was given.')}</p>
      <p>You have not been charged. You are welcome to change it and submit again.</p>`
  }),

  endingSoon: (title: string, ends: string) => ({
    type: 'ending_soon' as const,
    subject: `${title} ends ${ends}`,
    body: `<p><strong>${escapeHtml(title)}</strong> finishes ${escapeHtml(ends)}.</p>
      <p>If you would like it to keep running, book another block from your dashboard.</p>`
  })
}
