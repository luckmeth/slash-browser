'use server'

import { revalidatePath } from 'next/cache'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export type SaveResult = { error: string } | { ok: string } | undefined

/**
 * Writes one row of `platform_settings` or `browser_settings`.
 *
 * Values are stored as jsonb, so the form's text is parsed as JSON and rejected
 * if it is not — a malformed value silently stored as a string is a setting
 * that reads as its default for ever, with nothing anywhere saying so.
 *
 * **Secrets do not belong in either table.** The Stripe secret key and webhook
 * signing secret live in the host's encrypted environment; `browser_settings`
 * in particular is read unauthenticated by every copy of the browser, so
 * anything put there is public the moment it is saved.
 */
async function save(
  table: 'platform_settings' | 'browser_settings',
  path: string,
  formData: FormData
): Promise<SaveResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  const key = String(formData.get('key') ?? '')
  const raw = String(formData.get('value') ?? '')

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {
      error:
        'That is not valid JSON. Text needs quotes around it ("usd"), numbers and ' +
        'true/false do not.'
    }
  }

  const { error } = await supabaseService()
    .from(table)
    .update({ value, updated_by: admin.authUserId, updated_at: new Date().toISOString() })
    .eq('key', key)

  if (error) return { error: error.message }

  revalidatePath(path)
  return { ok: 'Saved.' }
}

export async function savePlatformSetting(_p: SaveResult, formData: FormData): Promise<SaveResult> {
  return save('platform_settings', '/settings', formData)
}

export async function saveBrowserSetting(_p: SaveResult, formData: FormData): Promise<SaveResult> {
  return save('browser_settings', '/browser', formData)
}
