'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * The client-side Supabase client.
 *
 * Uses the anon key, which is public by design — it identifies the project, it
 * does not authorise anything. What a signed-in person may actually read or
 * write is decided by row-level security in `0003_rls.sql`, on the server,
 * every time.
 */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
