'use client'

import { useActionState } from 'react'
import { saveCompany, type CompanyResult } from '@/app/company/actions'

/**
 * The company behind the adverts.
 *
 * Split into what readers see and what only we see, because those are two
 * different conversations and an advertiser filling this in is entitled to
 * know which is which. The name, the website and the description are shown or
 * linked; the address, the phone number and the tax id exist so an invoice and
 * a review decision have somewhere to go, and appear nowhere public.
 */
export function CompanyForm({
  company
}: {
  company: {
    company_name?: string | null
    contact_email?: string | null
    website?: string | null
    description?: string | null
    contact_name?: string | null
    contact_phone?: string | null
    address_line1?: string | null
    city?: string | null
    postcode?: string | null
    country?: string | null
    tax_id?: string | null
  }
}): React.JSX.Element {
  const [state, action, saving] = useActionState<CompanyResult, FormData>(saveCompany, undefined)
  const value = (key: keyof typeof company): string => String(company[key] ?? '')

  return (
    <form action={action} className="stack" style={{ maxWidth: 620 }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>What readers see</h3>

        <label htmlFor="company_name">Company name</label>
        <input
          id="company_name"
          name="company_name"
          defaultValue={value('company_name')}
          maxLength={120}
          required
        />
        <p className="note">
          Shown beside your advert, so readers know who is paying for it. Every placement in Slash
          is labelled — an advert that does not say it is one is the thing this browser blocks.
        </p>

        <label htmlFor="website" style={{ marginTop: 14 }}>
          Website
        </label>
        <input
          id="website"
          name="website"
          type="url"
          placeholder="https://example.com"
          defaultValue={value('website')}
          maxLength={200}
        />
        <p className="note">
          Has to be <code>https</code>. It is a link put in front of every reader who sees your
          advert, and an http link is one an intermediary can rewrite.
        </p>

        <label htmlFor="description" style={{ marginTop: 14 }}>
          What you do
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          maxLength={600}
          defaultValue={value('description')}
          placeholder="A sentence or two. It goes to whoever reviews your campaigns."
        />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>For us only</h3>
        <p className="note" style={{ marginTop: 0 }}>
          Never shown publicly. It is here so an invoice has an address, and so a question about a
          campaign reaches a person rather than a shared inbox.
        </p>

        <label htmlFor="contact_name" style={{ marginTop: 14 }}>
          Contact name
        </label>
        <input
          id="contact_name"
          name="contact_name"
          defaultValue={value('contact_name')}
          maxLength={120}
        />

        <label htmlFor="contact_email" style={{ marginTop: 14 }}>
          Contact email
        </label>
        <input
          id="contact_email"
          name="contact_email"
          type="email"
          defaultValue={value('contact_email')}
          maxLength={160}
          required
        />
        <p className="note">
          Where approvals, receipts and rejections go. This is the address we use, not the one you
          signed in with.
        </p>

        <label htmlFor="contact_phone" style={{ marginTop: 14 }}>
          Phone
        </label>
        <input
          id="contact_phone"
          name="contact_phone"
          defaultValue={value('contact_phone')}
          maxLength={32}
        />

        <label htmlFor="address_line1" style={{ marginTop: 14 }}>
          Address
        </label>
        <input
          id="address_line1"
          name="address_line1"
          defaultValue={value('address_line1')}
          maxLength={160}
        />

        <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="city">Town or city</label>
            <input id="city" name="city" defaultValue={value('city')} maxLength={80} />
          </div>
          <div style={{ width: 140 }}>
            <label htmlFor="postcode">Postcode</label>
            <input id="postcode" name="postcode" defaultValue={value('postcode')} maxLength={24} />
          </div>
          <div style={{ width: 110 }}>
            <label htmlFor="country">Country</label>
            <input
              id="country"
              name="country"
              defaultValue={value('country')}
              maxLength={2}
              placeholder="LK"
              style={{ textTransform: 'uppercase' }}
            />
          </div>
        </div>

        <label htmlFor="tax_id" style={{ marginTop: 14 }}>
          VAT or company number
        </label>
        <input id="tax_id" name="tax_id" defaultValue={value('tax_id')} maxLength={40} />
        <p className="note">Optional. It appears on invoices where your jurisdiction wants it.</p>
      </div>

      <div className="row">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save company profile'}
        </button>
        {state && 'ok' in state && <span className="note">{state.ok}</span>}
        {state && 'error' in state && <span className="error">{state.error}</span>}
      </div>
    </form>
  )
}
