import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Keeps the Supabase session cookie fresh.
 *
 * Server Components cannot write cookies, so a token that expires mid-visit
 * would sign somebody out halfway through building a campaign with no
 * explanation. Refreshing here — where cookies *can* be written — is what makes
 * `supabaseServer()` safe to call from a page.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value)
          response = NextResponse.next({ request })
          for (const { name, value, options } of list) response.cookies.set(name, value, options)
        }
      }
    }
  )

  // getUser(), not getSession(): it verifies the token with Supabase rather
  // than trusting whatever the cookie claims.
  await supabase.auth.getUser()

  return response
}

export const config = {
  matcher: [
    // Everything except static assets and the endpoints browsers call, which
    // carry no session and must stay as cheap and as anonymous as possible.
    '/((?!_next/static|_next/image|favicon.ico|api/tiles|api/report|api/stripe).*)'
  ]
}
