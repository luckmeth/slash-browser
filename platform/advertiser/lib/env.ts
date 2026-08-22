import { z } from 'zod'

/**
 * Configuration that must exist for the app to work at all.
 *
 * Validated once, at first import, so a missing key fails immediately with the
 * name of the key — rather than surfacing an hour later as an authentication
 * error nobody can trace back to a blank environment variable.
 *
 * **Secrets live here, not in `platform_settings`.** The Stripe secret key and
 * the webhook signing secret are read from the host's encrypted environment on
 * purpose: a secret stored in a database row is only as protected as the key
 * that encrypts it, and that key has to live in an environment variable anyway.
 * Putting it in a table buys a second copy of the secret and no extra safety.
 * Everything an operator genuinely needs to change without a deploy — prices,
 * the publishable key, live/test mode — is in `platform_settings` instead.
 */
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url(),

  // Server-only from here down. Never prefixed NEXT_PUBLIC_, because that
  // prefix is what puts a value into the JavaScript bundle every visitor
  // downloads.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().optional(),
  CRON_SECRET: z.string().min(1).optional()
})

const parsed = schema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  CRON_SECRET: process.env.CRON_SECRET
})

if (!parsed.success) {
  const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
  throw new Error(
    `Missing or invalid environment variables: ${missing}. ` +
      'Copy .env.example to .env.local and fill it in — see platform/README.md.'
  )
}

export const env = parsed.data

/** Whether payments can run at all. The UI says so plainly rather than failing at checkout. */
export function paymentsConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
}

/** Whether transactional email can be sent. Absent, the app still works and logs the gap. */
export function emailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM)
}
