# Manual test: Slash Coin

Automated coverage runs first — it is most of this feature's verification, and
the manual steps below only cover what genuinely cannot be automated.

```bash
npm run typecheck && npx eslint src && npx vitest run
SB=<supabase management token> python supabase/coinProbe.py
```

`coinProbe.py` must end with **SLASH_COIN_PROBE: all checks passed**. It creates
a real user, signs in, attacks the ledger 27 ways through PostgREST with a real
signed JWT, and deletes the user afterwards. It asserts the cleanup left nothing
behind — check that line, because a probe that leaks users pollutes the
production admin list.

## Before any of this can pass

Google is **not yet enabled** on the Supabase project. Until a Google Cloud
OAuth client id and secret are pasted into Supabase → Authentication →
Providers → Google, step 3 below will land on a Supabase error page rather than
Google's account chooser. See `docs/SLASH-COIN.md`.

## 1 · Off by default

1. Fresh profile. Open Settings.
2. **Slash Coin** group exists, the switch is **off**.
3. Start page shows **no** coin card.
4. Confirm nothing is being sent: no `rewards.session` file in the profile
   directory, and `coin_intervals` in the local database is empty.

## 2 · Switched on, signed out

1. Turn the switch on.
2. The section says *"Not signed in, so nothing is being collected or sent."*
3. Open **Slash Coin** — the page shows a zero balance and *"Sign in to start
   earning."*
4. Browse a real page for two minutes. The balance stays at zero and
   `coin_intervals` stays empty: signed out, nothing accrues and nothing is
   recorded.

## 3 · Sign-in (the part that cannot be automated)

1. Press **Sign in with Google**.
2. Your **normal browser** opens — not a window inside Slash. This is the whole
   point of the loopback flow; if a Slash window opens instead, the flow is
   wrong.
3. Complete the sign-in. The tab lands on a plain "Signed in" page.
4. Slash updates on its own, without being clicked: the page shows the account
   email.
5. Check the Supabase `profiles` row has `client = 'browser'`, and that **no**
   row was created in `advertisers` for that account.

## 4 · Earning

1. Browse an ordinary page with Slash focused. Within a minute or two the pill
   reads **Earning now** and pulses.
2. Click away to another application. Within one sample (30s) it reads
   *"Paused — Slash is not the active window."*
3. Come back, then open a new tab (`slash://newtab`). It reads *"Paused — open a
   page to earn."*
4. Leave the machine untouched for two minutes. It reads *"Paused — no activity
   on this machine."*
5. Open a **private window** and browse there. It does not earn, and says why.

## 5 · The money path

1. Browse for five minutes or so, focused, on a real page.
2. Press **Sync now**.
3. Balance increases. `coin_intervals` locally is emptied of reported rows.
4. In Supabase, the `coin_intervals` row's `claimed_seconds` is **not greater**
   than `ended_at - started_at`.

## 6 · Sleep, the easiest exploit

1. Sign in, browse a few minutes, then **suspend the machine** (not just lock).
2. Wake it an hour later and let one sample pass.
3. The balance must **not** have jumped by an hour. The pre-sleep stretch is
   banked; the sleeping hour is not.

This is worth doing by hand at least once even though `earningRules.test.ts`
covers it — the unit test proves the arithmetic, not that `powerMonitor` and the
timer behave as assumed across a real suspend.

## 7 · Signing out

1. **Sign out.** The balance area returns to the signed-out state.
2. Sign in as a *different* account. The first account's unreported intervals
   are **not** credited to the second — they are bound to the account that
   earned them.

## 8 · Regression checks

Slash Coin touches settings, IPC and the start page, so re-run:

- `docs/testing/phase-8.md`
- Any settings switch still toggles only itself (`SLASH_TOGGLES_PROBE`)
- The start page still shows the advertise card, and the sponsored placements
  still appear (`SLASH_AD_SHOWCASE`, `SLASH_SPONSOR_PROBE`)
