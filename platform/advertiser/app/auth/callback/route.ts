import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'
import { env } from '@/lib/env'

/**
 * Where Supabase sends people back after a confirmation link or Google sign-in.
 *
 * Exchanges the one-time code for a session cookie. The code is single-use and
 * short-lived, which is why it may travel in a URL when a password never may.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(`${env.NEXT_PUBLIC_SITE_URL}/login?error=no-code`)
  }

  const supabase = await supabaseServer()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    // Usually an expired or already-used link. Say so rather than dropping
    // somebody on a login page with no idea why their link did nothing.
    return NextResponse.redirect(`${env.NEXT_PUBLIC_SITE_URL}/login?error=link-expired`)
  }

  return NextResponse.redirect(`${env.NEXT_PUBLIC_SITE_URL}/dashboard`)
}
