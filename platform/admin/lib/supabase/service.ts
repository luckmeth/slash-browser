import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { env } from '../env'

/**
 * The service-role client. Bypasses row-level security entirely.
 *
 * `import 'server-only'` at the top is load-bearing: it makes the build fail if
 * this module is ever pulled into a client component, rather than shipping the
 * service-role key to every visitor. That mistake is silent otherwise, and it
 * hands out the whole database.
 *
 * Only four callers may legitimately use it, and each has a reason RLS cannot
 * cover:
 *
 *  - the Stripe webhook, which acts on nobody's session and must write a
 *    payment row after verifying a signature;
 *  - the batch endpoint, which reads every approved campaign for an
 *    unauthenticated browser and must read images out of a private bucket;
 *  - the report endpoint, which writes delivery counts no client may write;
 *  - the scheduled job, which moves campaigns across their own start and end.
 *
 * Anything else belongs on `supabaseServer()`, where the database enforces who
 * may see what.
 */
export function supabaseService() {
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. The batch, report, webhook and cron ' +
        'endpoints cannot run without it — see platform/README.md.'
    )
  }
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}
