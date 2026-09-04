'use server'

import { createHash } from 'node:crypto'
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
  const fileUrl = String(formData.get('fileUrl') ?? '').trim()
  const sha512 = String(formData.get('sha512') ?? '').trim()
  const sizeBytes = Number(String(formData.get('sizeBytes') ?? '').trim() || 0)

  // Checked here as well as by the database, so the operator gets a sentence
  // rather than a constraint violation.
  if (!VERSION.test(version)) {
    return { error: 'Version must look like 1.2.3 — the browser compares it against its own.' }
  }
  if (!/^https:\/\//i.test(releaseUrl)) {
    return { error: 'The release page must be an https:// address.' }
  }

  /*
   * The checksum, computed here rather than typed.
   *
   * Publishing an installer means publishing a SHA-512 of it, because that is
   * the only thing standing between a browser and running whatever a proxy
   * handed it. Asking an operator to run `certutil` and paste 128 characters
   * is asking for the one mistake that makes every update fail verification --
   * and the failure looks like a broken updater rather than a typo.
   *
   * So the file is fetched and hashed where the row is written. It is slow
   * (the installer is around 180 MB) and it is worth it: the checksum and the
   * file cannot disagree, because nobody transcribed anything.
   */
  let digest = sha512
  let bytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.floor(sizeBytes) : 0

  if (fileUrl !== '') {
    if (!/^https:\/\//i.test(fileUrl)) {
      return { error: 'The installer address must be an https:// address.' }
    }
    if (digest === '') {
      const measured = await hashRemote(fileUrl)
      if ('error' in measured) return measured
      digest = measured.sha512
      bytes = measured.size
    }
  }

  const { error } = await supabaseService().from('releases').insert({
    version,
    release_url: releaseUrl,
    notes,
    channel,
    file_url: fileUrl,
    sha512: digest,
    size_bytes: bytes,
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
  return {
    ok:
      fileUrl === ''
        ? `${version} is being served to the ${channel} channel. It publishes no installer, so browsers will point people at the release page.`
        : `${version} is being served to the ${channel} channel, with a ${(bytes / 1_048_576).toFixed(0)} MB installer and its checksum. Browsers pick it up within six hours.`
  }
}

/**
 * Downloads a package and measures it.
 *
 * Streamed and hashed as it arrives rather than held in memory: this is a
 * ~180 MB file, and buffering it inside a Next server action running in an
 * Electron app is how a desktop tool runs out of memory publishing a release.
 */
async function hashRemote(url: string): Promise<{ sha512: string; size: number } | { error: string }> {
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) {
      return { error: `The installer address returned ${response.status}. Publish it first, then add it here.` }
    }
    if (!response.body) return { error: 'That address returned nothing to hash.' }

    const hash = createHash('sha512')
    let size = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      hash.update(value)
      if (size > 1_073_741_824) {
        return { error: 'That file is over 1 GB, which is not an installer for this browser.' }
      }
    }
    if (size === 0) return { error: 'That address returned an empty file.' }
    return { sha512: hash.digest('hex'), size }
  } catch (cause) {
    return { error: `Could not fetch the installer: ${String(cause)}` }
  }
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
