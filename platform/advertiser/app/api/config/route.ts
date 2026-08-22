import { NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase/service'

/**
 * Remote configuration the browser reads.
 *
 * This is the other half of the admin app's "Browser config" page. Without it
 * that page edited a table nothing consumed — an operations screen whose
 * switches did nothing, which is exactly the kind of feature this project does
 * not ship.
 *
 * **Everything here is public.** Every copy of Slash reads it unauthenticated,
 * because requiring a key would mean each installation carried one and a
 * per-installation key is an identifier. Nothing may be put in `browser_settings`
 * that is not already public, and the admin page says so above the fields.
 *
 * Identical for every caller. No cookie, no parameter, nothing to vary on.
 */

export const dynamic = 'force-dynamic'

/** How long the browser may hold this before asking again. */
const TTL_SECONDS = 3600

export async function GET(): Promise<NextResponse> {
  try {
    const { data, error } = await supabaseService()
      .from('browser_settings')
      .select('key, value')

    if (error) throw error

    const settings: Record<string, unknown> = {}
    for (const row of data ?? []) settings[row.key] = row.value

    return NextResponse.json(
      { expiresAt: Date.now() + TTL_SECONDS * 1000, settings },
      { headers: { 'cache-control': `public, max-age=${TTL_SECONDS}` } }
    )
  } catch (cause) {
    console.error('could not serve browser config', cause)
    // An empty set rather than an error. The browser treats a missing key as
    // its default, so "nothing configured" and "could not reach us" produce the
    // same, safe, behaviour instead of a failure the user would see.
    return NextResponse.json({ expiresAt: Date.now() + 60_000, settings: {} })
  }
}
