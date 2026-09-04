import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'
import { currentAdvertiser } from '@/lib/supabase/server'
import { SignOutButton } from '@/components/SignOutButton'
import { BrandMark } from '@/components/BrandMark'

export const metadata: Metadata = {
  title: 'Advertise on Slash',
  description:
    'Your brand on the start page of the Slash browser. Bought by the hour, no targeting, no tracking, no auction.'
}

export default async function RootLayout({
  children
}: {
  children: React.ReactNode
}): Promise<React.JSX.Element> {
  // Read in the layout so every page gets the right header without each one
  // remembering to ask. Cheap: it is one indexed lookup on a session already
  // being verified.
  const advertiser = await currentAdvertiser().catch(() => null)

  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="inner">
            <Link href="/" className="brand">
              <BrandMark size={26} />
              Slash advertising
            </Link>
            <nav>
              {advertiser ? (
                <>
                  <Link href="/dashboard">Campaigns</Link>
                  <Link href="/campaigns/new">New campaign</Link>
                  <Link href="/company">Company</Link>
                  <span className="note">{advertiser.email}</span>
                  <SignOutButton />
                </>
              ) : (
                <>
                  <Link href="/#pricing">Pricing</Link>
                  <Link href="/login">Sign in</Link>
                  <Link href="/signup" className="button">
                    Start advertising
                  </Link>
                </>
              )}
            </nav>
          </div>
        </header>

        {children}

        <footer className="site">
          <div className="inner">
            Slash advertising · adverts are chosen on the reader&rsquo;s own machine, so we can
            report how often yours was shown and clicked, per day, and nothing else about who saw
            it.
          </div>
        </footer>
      </body>
    </html>
  )
}
