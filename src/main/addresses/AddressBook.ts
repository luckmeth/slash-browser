import type { SavedAddress } from '@shared/addressFields'
import type { Database } from '../db/Database'

interface Row {
  id: number
  label: string
  name: string
  given_name: string
  family_name: string
  organization: string
  street_line1: string
  street_line2: string
  city: string
  region: string
  postal_code: string
  country: string
  phone: string
  email: string
}

/**
 * Addresses the user typed in and asked Slash to keep.
 *
 * **Entered by hand, never captured from a page.** The same position
 * `PasswordVault` takes, for the same reason: a preload that reads what you type
 * into forms is a much larger change to what this browser is than a convenience
 * feature justifies, and it is not made quietly. `preload/content.ts` reports
 * only which *kinds* of field a page has — never a value.
 */
export class AddressBook {
  constructor(private readonly db: Database) {}

  list(): SavedAddress[] {
    return this.db.connection
      .prepare<[], Row>('SELECT * FROM saved_addresses ORDER BY label, id')
      .all()
      .map(toAddress)
  }

  get(id: number): SavedAddress | null {
    const row = this.db.connection
      .prepare<[number], Row>('SELECT * FROM saved_addresses WHERE id = ?')
      .get(id)
    return row ? toAddress(row) : null
  }

  save(input: Omit<SavedAddress, 'id'> & { id?: number }): SavedAddress {
    const now = Date.now()
    const values = {
      label: input.label.trim(),
      name: input.name.trim(),
      given: input.givenName.trim(),
      family: input.familyName.trim(),
      org: input.organization.trim(),
      line1: input.streetLine1.trim(),
      line2: input.streetLine2.trim(),
      city: input.city.trim(),
      region: input.region.trim(),
      postal: input.postalCode.trim(),
      country: input.country.trim(),
      phone: input.phone.trim(),
      email: input.email.trim(),
      now
    }

    if (input.id !== undefined && this.get(input.id)) {
      this.db.connection
        .prepare(
          `UPDATE saved_addresses SET label = @label, name = @name, given_name = @given,
             family_name = @family, organization = @org, street_line1 = @line1,
             street_line2 = @line2, city = @city, region = @region, postal_code = @postal,
             country = @country, phone = @phone, email = @email, updated_at = @now
           WHERE id = @id`
        )
        .run({ ...values, id: input.id })
      return this.get(input.id)!
    }

    const info = this.db.connection
      .prepare(
        `INSERT INTO saved_addresses
           (label, name, given_name, family_name, organization, street_line1, street_line2,
            city, region, postal_code, country, phone, email, created_at, updated_at)
         VALUES (@label, @name, @given, @family, @org, @line1, @line2,
                 @city, @region, @postal, @country, @phone, @email, @now, @now)`
      )
      .run(values)
    return this.get(Number(info.lastInsertRowid))!
  }

  delete(id: number): void {
    this.db.connection.prepare('DELETE FROM saved_addresses WHERE id = ?').run(id)
  }
}

function toAddress(row: Row): SavedAddress {
  return {
    id: row.id,
    label: row.label,
    name: row.name,
    givenName: row.given_name,
    familyName: row.family_name,
    organization: row.organization,
    streetLine1: row.street_line1,
    streetLine2: row.street_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    phone: row.phone,
    email: row.email
  }
}
