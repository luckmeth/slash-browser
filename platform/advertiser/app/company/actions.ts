'use server'

import { revalidatePath } from 'next/cache'
import { currentAdvertiser, supabaseServer } from '@/lib/supabase/server'

export type CompanyResult = { error: string } | { ok: string } | undefined

/**
 * The advertiser's own company profile.
 *
 * Written through **their** session, not the service-role client, on purpose.
 * `advertisers_update_own` already says an advertiser may write their own row
 * and nobody else's, and the column grant says which columns — so this handler
 * being wrong cannot become one advertiser editing another. The service-role
 * key exists for the four jobs row-level security cannot express, and this is
 * not one of them.
 *
 * `status` is not writable by anybody here: the policy compares it against the
 * stored value, so a suspended advertiser cannot un-suspend themselves by
 * posting a form.
 */
export async function saveCompany(
  _previous: CompanyResult,
  formData: FormData
): Promise<CompanyResult> {
  const advertiser = await currentAdvertiser()
  if (!advertiser) return { error: 'Sign in first.' }

  const text = (name: string, max: number): string =>
    String(formData.get(name) ?? '')
      .trim()
      .slice(0, max)

  const companyName = text('company_name', 120)
  if (companyName === '') return { error: 'A company name is needed — it is what readers see.' }

  const contactEmail = text('contact_email', 160)
  if (!contactEmail.includes('@')) return { error: 'A contact email is needed.' }

  const website = text('website', 200)
  if (website !== '' && !/^https:\/\//i.test(website)) {
    // The same rule the browser applies to a publisher notice: a link we put
    // in front of readers is https or it is not shown.
    return { error: 'The website has to start with https:// — an advert links to it.' }
  }

  const country = text('country', 2).toUpperCase()
  if (country !== '' && !/^[A-Z]{2}$/.test(country)) return { error: 'Choose a country.' }

  const supabase = await supabaseServer()
  const { error } = await supabase
    .from('advertisers')
    .update({
      company_name: companyName,
      contact_email: contactEmail,
      website,
      description: text('description', 600),
      contact_name: text('contact_name', 120),
      contact_phone: text('contact_phone', 32),
      address_line1: text('address_line1', 160),
      city: text('city', 80),
      postcode: text('postcode', 24),
      country,
      tax_id: text('tax_id', 40),
      profile_updated_at: new Date().toISOString()
    })
    .eq('auth_user_id', advertiser.authUserId)

  if (error) {
    if (/column .* does not exist/i.test(error.message)) {
      return {
        error:
          'This deployment is missing the company profile columns. Apply ' +
          'supabase/migrations/20260903_collector_profiles.sql.'
      }
    }
    return { error: error.message }
  }

  revalidatePath('/company')
  revalidatePath('/dashboard')
  return { ok: 'Saved.' }
}
