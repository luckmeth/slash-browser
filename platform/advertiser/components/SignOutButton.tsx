'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase/browser'

export function SignOutButton(): React.JSX.Element {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      className="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await supabaseBrowser().auth.signOut()
        // refresh() rather than push(): the header is rendered on the server
        // from the session cookie, so navigating without re-rendering would
        // leave it showing a signed-in menu for a signed-out person.
        router.refresh()
        router.push('/')
      }}
    >
      Sign out
    </button>
  )
}
