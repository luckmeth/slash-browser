'use server'

import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'
import { env } from '@/lib/env'
import { emails, sendEmail } from '@/lib/email'

/**
 * Sign-in and sign-up, as server actions.
 *
 * Server-side rather than from the browser so the welcome email can be sent and
 * logged without exposing an endpoint that emails anyone on request. The
 * password reaches Supabase over the same TLS connection either way — it is
 * never stored, logged, or put in a URL here.
 */

export type AuthResult = { error: string } | undefined

export async function signUp(_prev: AuthResult, formData: FormData): Promise<AuthResult> {
  const company = String(formData.get('company') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const password = String(formData.get('password') ?? '')

  if (company === '') return { error: 'A company name is needed.' }
  if (!email.includes('@')) return { error: 'That does not look like an email address.' }
  if (password.length < 8) return { error: 'Passwords must be at least 8 characters.' }

  const supabase = await supabaseServer()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Read by the handle_new_user trigger, which creates the advertiser row.
      data: { company_name: company },
      emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback`
    }
  })

  if (error) return { error: error.message }

  // Best-effort, and after the account exists. A failed welcome email is logged
  // and forgotten — it must never be the reason somebody cannot sign up.
  if (data.user) {
    await sendEmail({ to: email, ...emails.welcome(company) })
  }

  // With email confirmation switched on there is no session yet, and sending
  // them to the dashboard would bounce straight back to the login page with no
  // explanation. Say what happened instead.
  if (!data.session) redirect('/login?check-email=1')

  redirect('/dashboard')
}

export async function signIn(_prev: AuthResult, formData: FormData): Promise<AuthResult> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const password = String(formData.get('password') ?? '')

  const supabase = await supabaseServer()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  // One message for both causes. Saying which half was wrong tells whoever is
  // guessing which addresses have accounts here.
  if (error) return { error: 'That email and password do not match.' }

  redirect('/dashboard')
}

export async function signInWithGoogle(): Promise<void> {
  const supabase = await supabaseServer()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback` }
  })
  if (error || !data.url) redirect('/login?oauth=unavailable')
  redirect(data.url)
}
