import { z } from 'zod'

/**
 * A saved address.
 *
 * **Entered by hand, never captured from a page.** The same position the
 * password vault takes: a preload that reads what you type into forms is a much
 * larger change to what this browser is than a convenience feature justifies.
 *
 * There is deliberately **no card number field**. Storing one means holding a
 * primary account number, which is a regulated category of data with obligations
 * this project cannot meet, and the browser has no way to protect it that a
 * password manager does not do better. Slash fills addresses; it does not fill
 * payment cards, and says so rather than half-doing it.
 */
export const SavedAddressSchema = z.object({
  id: z.number().int(),
  /** What the user calls it — "Home", "Work". Shown when choosing. */
  label: z.string().max(60).default(''),
  name: z.string().max(120).default(''),
  givenName: z.string().max(120).default(''),
  familyName: z.string().max(120).default(''),
  organization: z.string().max(120).default(''),
  streetLine1: z.string().max(200).default(''),
  streetLine2: z.string().max(200).default(''),
  city: z.string().max(120).default(''),
  region: z.string().max(120).default(''),
  postalCode: z.string().max(40).default(''),
  country: z.string().max(120).default(''),
  phone: z.string().max(60).default(''),
  email: z.string().max(200).default('')
})
export type SavedAddressRecord = z.infer<typeof SavedAddressSchema>
