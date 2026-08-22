import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'
import { currentAdmin } from '@/lib/supabase/server'
import { SignOutButton } from '@/components/SignOutButton'

export const metadata: Metadata = {
  title: 'Slash advertising — operations',
  // Nothing here should ever be indexed. It is an internal tool that happens to
  // be reachable over the internet.
  robots: { index: false, follow: false }
}

export default async function RootLayout({
  children
}: {
  children: React.ReactNode
}): Promise<React.JSX.Element> {
  const admin = await currentAdmin().catch(() => null)

  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="inner">
            <Link href="/" className="brand">
              Slash operations
            </Link>
            {admin && (
              <nav>
                <Link href="/">Overview</Link>
                <Link href="/queue">Review queue</Link>
                <Link href="/pricing">Pricing</Link>
                <Link href="/releases">Releases</Link>
                <Link href="/browser">Browser config</Link>
                <Link href="/settings">Settings</Link>
                <Link href="/emails">Email log</Link>
                <span className="note">{admin.email}</span>
                <SignOutButton />
              </nav>
            )}
          </div>
        </header>
        {children}
      </body>
    </html>
  )
}
