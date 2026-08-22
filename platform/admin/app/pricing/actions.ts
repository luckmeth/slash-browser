'use server'

import { revalidatePath } from 'next/cache'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export type SaveResult = { error: string } | { ok: string } | undefined

/**
 * Saves one placement's terms.
 *
 * Re-checks operator membership: a server action is a POST endpoint anyone who
 * finds its name can call, so hiding the form is not a check.
 *
 * The rate change itself is logged by a database trigger rather than here —
 * a log the application can forget to write is a log you cannot rely on when
 * an advertiser asks what they were charged.
 */
export async function saveTier(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  const tier = String(formData.get('placementTier') ?? '')
  const rate = Number(formData.get('hourlyRate'))
  const minHours = Math.round(Number(formData.get('minHours')))
  const maxConcurrent = Math.round(Number(formData.get('maxConcurrent')))
  const displayName = String(formData.get('displayName') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim()
  const active = formData.get('active') === 'on'

  if (!Number.isFinite(rate) || rate < 0) return { error: 'The hourly rate must be a number.' }
  if (!Number.isInteger(minHours) || minHours < 1) return { error: 'Minimum hours must be at least 1.' }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    return { error: 'Maximum at once must be at least 1.' }
  }
  if (displayName === '') return { error: 'A display name is needed — the public site shows it.' }

  const { error } = await supabaseService()
    .from('pricing_config')
    .update({
      hourly_rate: Number(rate.toFixed(2)),
      min_hours: minHours,
      max_concurrent: maxConcurrent,
      display_name: displayName,
      description,
      active,
      updated_by: admin.authUserId
    })
    .eq('placement_tier', tier)

  if (error) return { error: error.message }

  revalidatePath('/pricing')
  return { ok: 'Saved. The public site is showing this now.' }
}
