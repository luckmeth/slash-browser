'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton } from './SignOutButton'

/**
 * The operator navigation.
 *
 * A client component for one reason: it marks where you are. Seven
 * indistinguishable links, in an application whose pages all look alike, meant
 * the only way to know which screen you were on was to read its heading.
 *
 * Grouped in the order the work happens — what came in, what it costs, what
 * the browser does with it, then the plumbing — rather than alphabetically or
 * by the order the pages were built.
 */
const PAGES: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/', label: 'Overview' },
  { href: '/queue', label: 'Review queue' },
  { href: '/advertisers', label: 'Advertisers' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/coin', label: 'Slash Coin' },
  { href: '/collectors', label: 'Collectors' },
  { href: '/payouts', label: 'Payouts' },
  { href: '/browser', label: 'Browser' },
  { href: '/releases', label: 'Releases' },
  { href: '/emails', label: 'Email log' },
  { href: '/settings', label: 'Settings' }
]

export function Nav({ email }: { email: string }): React.JSX.Element {
  const path = usePathname()

  return (
    <nav>
      {PAGES.map((page) => (
        <Link
          key={page.href}
          href={page.href}
          className={isCurrent(path, page.href) ? 'on' : undefined}
          aria-current={isCurrent(path, page.href) ? 'page' : undefined}
        >
          {page.label}
        </Link>
      ))}
      <span className="who">{email}</span>
      <SignOutButton />
    </nav>
  )
}

/**
 * Overview is the only exact match.
 *
 * Everything else marks its section for the pages beneath it, so a campaign
 * opened from the queue still shows the queue as current — the alternative is
 * a navigation bar that forgets where you are the moment you go one level in.
 */
function isCurrent(path: string | null, href: string): boolean {
  if (path === null) return false
  return href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`)
}
