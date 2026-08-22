'use server'

import { revalidatePath } from 'next/cache'
import { currentAdmin } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'

export type ReleaseResult = { error: string } | { ok: string } | undefined

/** Semver, loosely — enough to reject "latest" and "v2 final". */
const VERSION = /^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i

export async function publishRelease(
  _prev: ReleaseResult,
  formData: FormData
): Promise<ReleaseResult> {
  const admin = await currentAdmin()
  if (!admin) return { error: 'Not an operator.' }

  const version = String(formData.get('version') ?? '').trim()
  const releaseUrl = String(formData.get('releaseUrl') ?? '').trim()
  const notes = String(formData.get('notes') ?? '').trim().slice(0, 2000)
  const channel = formData.get('channel') === 'beta' ? 'beta' : 'stable'

  // Checked here as well as by the database, so the operator gets a sentence
  // rather than a constraint violation.
  if (!VERSION.test(version)) {
    return { error: 'Version must look like 1.2.3 — the browser compares it against its own.' }
  }
  if (!/^https:\/\//i.test(releaseUrl)) {
    return { error: 'The release page must be an https:// address.' }
  }

  const { error } = await supabaseService().from('releases').insert({
    version,
    release_url: releaseUrl,
    notes,
    channel,
    published: true,
    created_by: admin.authUserId
  })

  if (error) {
    return {
      error: error.message.includes('duplicate')
        ? `${version} already exists on the ${channel} channel.`
        : error.message
    }
  }

  revalidatePath('/releases')
  return { ok: `${version} is now being served to the ${channel} channel.` }
}

/**
 * Pulls a release out of the feed.
 *
 * The previous published release starts being served again on the next check,
 * which is the closest thing an update feed has to a rollback. The row is kept
 * rather than deleted so the history of what was served stays intact.
 */
export async function unpublishRelease(
  _prev: ReleaseResult,
  formData: FormData
): Promise<ReleaseResult> {
  if (!(await currentAdmin())) return { error: 'Not an operator.' }

  const id = String(formData.get('id') ?? '')
  const { error } = await supabaseService()
    .from('releases')
    .update({ published: false })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath('/releases')
  return { ok: 'Pulled. The previous release is being served again.' }
}
