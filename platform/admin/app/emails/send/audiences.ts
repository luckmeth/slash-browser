/**
 * Who a broadcast can go to.
 *
 * Its own module because a `'use server'` file may export only async
 * functions -- and because these are wanted by the client component that draws
 * the form as well as by the action that sends it. One list, so the label an
 * operator picks and the query that runs cannot describe different people.
 */

export const BROADCAST_CAP = 200

export type Audience =
  | 'collectors'
  | 'collectors_no_wallet'
  | 'collectors_complete'
  | 'advertisers'
  | 'advertisers_active'

export const AUDIENCES: ReadonlyArray<{ value: Audience; label: string; why: string }> = [
  {
    value: 'collectors',
    label: 'Collectors — everyone',
    why: 'Every Slash Coin account that has not opted out.'
  },
  {
    value: 'collectors_no_wallet',
    label: 'Collectors — no payout wallet yet',
    why: 'People who are earning but could not be paid. The nudge that is actually worth sending.'
  },
  {
    value: 'collectors_complete',
    label: 'Collectors — details filled in',
    why: 'Accounts that could be paid today.'
  },
  { value: 'advertisers', label: 'Advertisers — everyone', why: 'Every advertiser account.' },
  {
    value: 'advertisers_active',
    label: 'Advertisers — active only',
    why: 'Excludes suspended advertiser accounts.'
  }
]

export interface Recipient {
  email: string
  name: string
}

/**
 * Why the person is getting it, in the footer of the message.
 *
 * A collector told they have an advertiser account is wrong in the one line
 * whose job is to explain how somebody ended up on this list -- which is the
 * line a spam report is filed over.
 */
export function footerFor(audience: Audience): string {
  return audience.startsWith('collectors')
    ? 'You are receiving this because you have a Slash Coin account. You can turn these off in the browser, under Slash Coin → Your details.'
    : 'You are receiving this because you have an advertiser account.'
}
