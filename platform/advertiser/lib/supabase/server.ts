import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { env } from '../env'

/**
 * A Supabase client bound to the caller's session cookie.
 *
 * Everything it does runs as the signed-in person, under row-level security —
 * so a bug in a page cannot read another advertiser's campaigns even if the
 * query asks for them. That is the point of using this client everywhere rather
 * than the service-role one: the database, not the page, decides what is
 * visible.
 */
export async function supabaseServer() {
  const store = await cookies()
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // session is refreshed by middleware instead, so this is expected
          // rather than an error worth surfacing.
        }
      }
    }
  })
}

/**
 * The signed-in advertiser, or null.
 *
 * Returns the advertiser row rather than the auth user, because every other
 * table keys off `advertisers.id`. A signed-in auth user with no advertiser row
 * is someone who abandoned signup halfway; treated as signed out.
 */
export async function currentAdvertiser() {
  const supabase = await supabaseServer()
  const {
    data: { user }
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('advertisers')
    .select('id, company_name, contact_email, status')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  return data ? { ...data, authUserId: user.id, email: user.email ?? '' } : null
}
