import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { env } from '../env'

/** A Supabase client bound to the caller's session cookie. */
export async function supabaseServer() {
  const store = await cookies()
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          // Server Component: cookies are read-only here. Middleware refreshes.
        }
      }
    }
  })
}

/**
 * The signed-in operator, or null.
 *
 * Membership of `admin_users` is what makes somebody an operator — checked
 * against the database on every request, not carried in a cookie or a claim.
 * There is deliberately no way to add yourself: the table has no insert grant
 * below the service role, because a self-serve route to becoming an operator is
 * a self-serve route to approving your own adverts.
 */
export async function currentAdmin() {
  const supabase = await supabaseServer()
  const {
    data: { user }
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('admin_users')
    .select('id, role')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  return data ? { ...data, email: user.email ?? '', authUserId: user.id } : null
}
