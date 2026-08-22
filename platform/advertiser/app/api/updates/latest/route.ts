import { NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase/service'

/**
 * The update feed every copy of Slash checks.
 *
 * Shape must match `FeedSchema` in the browser's `UpdateService` exactly:
 * `{ version, releaseUrl }`. Anything else is ignored wholesale rather than
 * partially applied, so a drift here means every browser silently stops
 * learning about new versions.
 *
 * Serves the single newest **published** release for the channel. Unpublishing
 * a bad release makes the previous one start being served again on the next
 * check — which is the closest thing to a rollback an update feed has.
 *
 * Deliberately identical for every caller: no cookie, no parameter beyond the
 * channel, nothing to vary on. An update check should not be a way of counting
 * installations.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const channel = new URL(request.url).searchParams.get('channel') === 'beta' ? 'beta' : 'stable'

  try {
    const { data, error } = await supabaseService()
      .from('releases')
      .select('version, release_url')
      .eq('channel', channel)
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      // No published release. A 404 rather than an empty object: the browser
      // reports "could not reach the feed", which is honest — there is nothing
      // here yet — whereas a malformed body would have it report the feed as
      // broken.
      return NextResponse.json({ error: 'no published release' }, { status: 404 })
    }

    return NextResponse.json(
      { version: data.version, releaseUrl: data.release_url },
      { headers: { 'cache-control': 'public, max-age=900' } }
    )
  } catch (cause) {
    console.error('could not serve the update feed', cause)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
