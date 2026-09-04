'use server'

import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'

export type LoginResult = { error: string } | undefined

/**
 * Signs in, then checks operator membership.
 *
 * A correct password for an advertiser account signs in fine and then finds
 * nothing here — every page checks `admin_users` on every request, and the
 * database refuses the queries besides. This message exists so that person
 * understands what happened rather than staring at an empty tool.
 */
export async function signIn(_prev: LoginResult, formData: FormData): Promise<LoginResult> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')

  const supabase = await supabaseServer()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data.user) return { error: 'That email and password do not match.' }

  const { data: admin } = await supabase
    .from('admin_users')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .maybeSingle()

  if (!admin) {
    await supabase.auth.signOut()
    return { error: 'That account is not an operator.' }
  }

  redirect('/')
}
