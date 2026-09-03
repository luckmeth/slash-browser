'use server'

import { revalidatePath } from 'next/cache'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export type CollectorResult = { error: string } | { ok: string } | undefined

/**
 * Suspends a collector, or lifts it.
 *
 * A suspended account keeps reporting and earns nothing, and is **not told
 * why** — telling somebody the exact moment they were caught only teaches them
 * which signal to change. Their history is kept: deleting the evidence of
 * fraud along with the fraud makes an appeal impossible to judge.
 *
 * The reason is written into the row so that the next operator to look knows
 * why, rather than finding a flag nobody can account for.
 */
export async function setSuspended(
  _previous: CollectorResult,
  formData: FormData
): Promise<CollectorResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  const id = String(formData.get('id') ?? '')
  const suspended = formData.get('suspended') === 'true'
  if (id === '') return { error: 'No account given.' }

  const { error } = await supabaseService()
    .from('profiles')
    .update({ suspended })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath(`/collectors/${id}`)
  revalidatePath('/collectors')
  return {
    ok: suspended
      ? 'Suspended. They keep reporting, earn nothing, and are not told why.'
      : 'Suspension lifted. Earning resumes on their next report.'
  }
}
