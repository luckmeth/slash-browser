import 'server-only'
import Stripe from 'stripe'
import { env } from './env'

/**
 * Stripe, or a clear explanation of why not.
 *
 * The secret key is read from the environment rather than from
 * `platform_settings`, for the reason set out in `env.ts`: a secret in a
 * database row still needs an encryption key in an environment variable, so it
 * is two copies of the secret and no more safety. Going live is still a
 * configuration change and not a code change — you set the live key in the
 * host's dashboard and flip `stripe_mode` in the admin app.
 */
export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set, so checkout cannot run. Add a test key from ' +
        'dashboard.stripe.com/test/apikeys to .env.local — see platform/README.md.'
    )
  }
  // No apiVersion pinned here on purpose. The SDK types accept exactly the
  // version it ships against, so hard-coding one turns every routine
  // `npm update stripe` into a type error in a file nobody was touching.
  // The SDK sends its own matching version by default.
  return new Stripe(env.STRIPE_SECRET_KEY)
}

/**
 * Whether these keys are Stripe's test keys.
 *
 * Used to put an unmissable banner on the checkout page. Someone who thinks
 * they are taking real money while running in test mode finds out at the end of
 * the month, from their bank.
 */
export function isTestMode(): boolean {
  return env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ?? true
}
