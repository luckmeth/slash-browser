'use server'

import { supabaseService } from '@/lib/supabase/service'

export type BootstrapResult = { error: string } | { ok: string } | undefined

/**
 * Creates the very first operator, when there are none.
 *
 * Exists so that standing this up does not require running the *public
 * advertiser website* in a terminal purely to reach a signup form, and then a
 * third tool — the Supabase SQL editor — to grant the row. Three applications
 * for one account is not a setup process, it is an obstacle course.
 *
 * **Only ever the first.** The count is re-checked inside this action rather
 * than trusted from whatever the page decided when it rendered: a page can be
 * left open, reloaded from cache, or opened twice, and "there were no operators
 * a minute ago" is not the same claim as "there are none now". Once one exists
 * this refuses, permanently.
 *
 * Reachable only by someone who already holds the service-role key — that is
 * what the desktop app asks for on first run, and what a browser at
 * localhost:3001 needs in its environment. So this is not an escalation path:
 * anybody who can call it could already do this by hand.
 */
export async function createFirstOperator(
  _prev: BootstrapResult,
  formData: FormData
): Promise<BootstrapResult> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')

  if (!email.includes('@')) return { error: 'That does not look like an email address.' }
  if (password.length < 10) {
    // Longer than the advertiser minimum on purpose: this account can approve
    // what appears on the start page of every copy of the browser.
    return { error: 'Use at least 10 characters — this account approves what everyone sees.' }
  }

  const supabase = supabaseService()

  const { count, error: countError } = await supabase
    .from('admin_users')
    .select('id', { count: 'exact', head: true })

  if (countError) return { error: `Could not reach the database: ${countError.message}` }
  if ((count ?? 0) > 0) {
    return { error: 'An operator already exists. Sign in, or add another from the database.' }
  }

  // Pre-confirmed: there is no inbox to click a link in yet, and this account is
  // being created by somebody already holding the database key.
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { company_name: 'Operations' }
  })

  if (createError || !created.user) {
    return { error: createError?.message ?? 'The account could not be created.' }
  }

  const { error: grantError } = await supabase
    .from('admin_users')
    .insert({ auth_user_id: created.user.id, role: 'owner' })

  if (grantError) {
    // The auth account exists but is not an operator, which would leave the app
    // showing a login form that this account can never get past. Removing it
    // puts things back where they were.
    await supabase.auth.admin.deleteUser(created.user.id)
    return { error: `Could not grant operator access: ${grantError.message}` }
  }

  return { ok: 'Operator created. Sign in below.' }
}
