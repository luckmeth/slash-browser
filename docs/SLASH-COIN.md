# Slash Coin

A pre-launch rewards balance: the longer somebody browses with Slash, the more
coins they accrue. Opt-in, Google sign-in, balances held server-side in
Supabase.

## The one rule the design is built around

**The server is the authority on balances. The client only reports intervals.**

These are intended to become tradeable one day. A balance the client owns is a
balance a text editor can forge, so the browser never computes a total and
uploads it. It accumulates *qualifying time*, posts closed intervals, and
displays whatever comes back. The client is assumed hostile throughout — it runs
on a machine its owner controls, so its clock, its device id and its request
volume are all attacker-chosen.

## What is where

| Piece | Lives in | Job |
|---|---|---|
| `earningRules.ts` | `src/main/rewards/` | Pure, clock-injected. Decides whether a moment qualifies and folds samples into intervals. 30 unit tests. |
| `ActivityTracker.ts` | `src/main/rewards/` | The 30-second timer. Holds no rules of its own. |
| `RewardsService.ts` | `src/main/rewards/` | Loopback OAuth, `safeStorage` token, posting the outbox. |
| `coin_intervals` (SQLite) | migration 26 | Local outbox. Rows are deleted only once the server has answered. |
| `record_coin_intervals()` | Postgres | **The fraud boundary.** The only write path into the ledger. |
| `RewardsPage.tsx` | `src/renderer/features/newtab/` | `slash://rewards` — balance, today against the cap, countdown. |

## What qualifies

All of these, at once, or nothing accrues:

- Slash is the **focused** window — not `focusedWindow()`, which falls back to
  the first window and would let a browser sitting behind an IDE earn all
  afternoon
- `powerMonitor.getSystemIdleTime()` is under two minutes
- A real page is open — not `slash://`, `about:`, `chrome://`, `file://`, `data:`
- Not a private window: earning would mean reporting the browsing happened,
  which is the one thing that mode promises not to do
- The daily cap has not been reached

`blockersFor` returns *every* reason rather than the first, because "why did I
not earn anything for two hours" is otherwise unanswerable, and `explain` turns
that into the sentence the screen shows.

## The fraud boundary

Everything below is enforced in Postgres, where the client cannot reach it.
`supabase/coinProbe.py` attacks each one with a real signed JWT through
PostgREST — not through the management API, which runs as `postgres` and
bypasses RLS, and would therefore pass every test while a real client sailed
through.

| Attack | What stops it |
|---|---|
| Replay the same batch | `EXCLUDE USING gist` on `(user_id, tstzrange(started_at, ended_at))` |
| Claim the same hours from a second device | The same constraint — twenty machines on one account earn the time of one |
| Claim a day of time inside ten minutes | `claimed_seconds <= span`, checked as a column constraint *and* in the function |
| Post-date or back-date | `clock_skew_seconds` forward, `max_age_days` back |
| Set your own balance | No insert/update policy on `coin_balances` for anyone. RLS refuses it. |
| Write or delete the ledger | Same — `coin_intervals` has a select policy and nothing else |
| Read somebody else's ledger | `user_id = auth.uid() or is_admin()` |
| Un-suspend yourself | The update policy's `with check` pins `suspended` to its current value |
| Exhaust the server with one request | 500-entry batch cap |
| Bank the hours a laptop spent asleep | `MAX_SAMPLE_GAP_MS` — time accrues only between two consecutive qualifying samples |

The overlap rule is a **constraint, not a code path**, deliberately: it holds
even if the crediting function is wrong.

### One bug worth recording

The first version of the per-entry exception handler named individual SQLSTATEs
and missed `invalid_datetime_format`. A single entry reading `"not-a-date"`
therefore aborted the **whole batch** rather than being skipped — which a
hostile client could have used to throw away an honest user's fortnight of
unreported time. It is now caught by category (`data_exception`, all of 22xxx).
Found by the probe, not by reading.

## Sign-in

Google's FedCM is not implemented in Electron — the same wall that breaks
`claude.ai/login` in this browser — so an in-app Google button cannot work, and
a button that cannot work is worse than no button.

Loopback PKCE instead, the standard desktop flow:

1. One-shot HTTP listener on a random port, bound to `127.0.0.1` specifically
2. The **system browser** opens at Supabase's Google authorize URL
3. The listener answers exactly one request, compares `state` in constant time,
   and closes
4. The refresh token is encrypted with `safeStorage` (DPAPI) and written beside
   the profile — never in settings, never in a renderer, never on disk in the
   clear. No secure store means no sign-in rather than a readable fallback.

The access token is deliberately *not* persisted: it is short-lived, and one
read from disk at launch is one more place it can be found.

## Still to do before this can ship

**Google is configured and the handshake passes.** Verified against the live
endpoint on 2026-09-01: the authorize chain reaches Google's real sign-in page
with no error. An earlier Desktop-app client failed with `redirect_uri_mismatch`
— Google will not accept an https redirect for those and the console does not
offer the field — and it was replaced with a **Web application** client whose
authorised redirect URI is:

```
https://edsuuwzihojdsmgzhzyw.supabase.co/auth/v1/callback
```

`supabase/configureGoogle.py` sets the client id and secret, keeps the loopback
allow list in place, and then walks the real authorize chain and says where it
ends up. Run `--check` on its own to test without changing anything:

```bash
SB=<management token> python supabase/configureGoogle.py --check
```

Google has **no public API for creating a general-purpose OAuth client** — the
only programmatic route is the IAP one, which is locked to IAP usage, cannot set
a redirect URI, and is organisation-internal. Creating the client is console
work by design; everything after it is in the script above.

### The state parameter, and why its absence is accepted

Supabase runs the Google leg itself and keeps its own `state` for it. What
arrives at the loopback listener is `?code=…` with **no echo of the value Slash
sent** — measured, not assumed. The first implementation required a match, which
would have rejected every genuine sign-in after all the configuration was
correct.

`checkCallback` therefore accepts an absent state and refuses a present-but-wrong
one. The binding in this flow is **PKCE**, as RFC 8252 intends: the code cannot
be exchanged without the `code_verifier` generated in-process and never
transmitted, so an injected code is inert. The listener is single-use, bound to
`127.0.0.1`, on an ephemeral port.

The exchange itself is `POST /auth/v1/token?grant_type=pkce` with `auth_code` and
`code_verifier`; both names were confirmed against the live endpoint, which
answers `flow_state_not_found` for an unknown code and `validation_failed` for a
wrong parameter name.

**The OAuth round trip has not been run end to end.** It opens a real external
browser and cannot be automated meaningfully from inside the app. Everything
either side of it is verified; the hand-off itself is not.

**Legal advice before announcing any conversion.** Granting future value in
exchange for present activity is the structure regulators examine most closely.
The in-product wording is "points, no cash value" and `COIN_DISCLAIMER` is the
single place it lives — keep it that way until there is advice saying otherwise.

## For the admin application

**These settings have a screen now: Slash Operations, `Slash Coin`**
(`platform/admin/app/coin`). It writes the row below with the service-role key,
and shows what each figure will look like in the browser as it is typed --
because `10` and `0.05` in two boxes are unreadable as a policy, and the person
setting them is deciding a policy. The rules for what may be saved are pure and
tested in `platform/shared/src/coin.ts`: an empty coin value un-publishes it,
while an empty earning rate is a mistake, and both of those are "the box is
empty" in the same form.

The queries below remain the reference for anything the screen does not cover,
and are readable with an admin session; no new endpoints needed.

```sql
-- every user's earnings
select p.id, p.email, p.display_name, p.suspended, p.client,
       coalesce(b.total, 0) as coins, b.updated_at
from profiles p
left join coin_balances b on b.user_id = p.id
order by coins desc;

-- one user's ledger
select started_at, ended_at, qualifying_seconds, claimed_seconds, coins, device_id, day
from coin_intervals where user_id = $1 order by started_at desc;

-- machines per account, which is what farming looks like
select user_id, count(*) as devices from devices group by user_id order by devices desc;

-- the knobs the admin application sets
update coin_config set
  earning_active    = $1,   -- false credits nothing for anybody; see below
  coins_per_hour    = $2,   -- earning rate; the browser derives "N minutes a coin"
  daily_cap_seconds = $3,
  launch_at         = $4,   -- drives the countdown; NULL falls back to campaign_ends_at
  coin_to_usd       = $5,   -- NULL until published; the browser shows "Pending"
  campaign_ends_at  = $6,
  updated_at = now(), updated_by = auth.uid();

-- pause the whole scheme
update coin_config set earning_active = false;

-- back to Pending
update coin_config set coin_to_usd = null;

-- suspend an account: it keeps reporting and earns nothing, and is not told why
update profiles set suspended = true where id = $1;
```

`claimed_seconds` beside `qualifying_seconds` is the signal worth watching: a
large and persistent gap between them means a client repeatedly asking for more
than the cap allows.

### The advertising rate card

`pricing_config` already holds it, and its tiers do **not** match the browser's
placement ids:

| `pricing_config.placement_tier` | Browser placement |
|---|---|
| `home_banner` | `tile` |
| `newtab_feature` | `tile` (featured) |
| `newtab_banner` | `banner` |
| `newtab_background` | `background` |
| `browser_notice` | `notice` |
| *(none)* | `rail` |

The advertise page reads `advertising.placements` from remote config, not from
`pricing_config`, so the two are currently independent. Reconciling them is an
admin-app job and is deliberately not done here by silently remapping names.

## The published rates

Three figures the browser only *displays* — it never invents them:

| Column | Shown as | When unset |
|---|---|---|
| `coins_per_hour` | "10 coins / hour" and "6 minutes of browsing earns 1 coin" | Pending |
| `coin_to_usd` | "$0.0100 / coin", plus what the balance would be worth | **Pending** |
| `launch_at` | The countdown | Falls back to `campaign_ends_at` |
| `earning_active` | "Earning active" or a paused banner | Absent reads as **active** |

`coin_to_usd` and `launch_at` are **nullable on purpose**. A rate nobody has set
is not zero — zero is a rate, and rendering it would tell somebody their coins
are worth nothing rather than that the figure has not been decided. Null renders
as `Pending`.

### Pausing has to be real

`earning_active` is the scheme itself being switched off, which is a different
thing from `profiles.suspended` -- that is one account, and an anti-abuse
control. A pause is visible: the rewards page says earning is paused for
everyone, in as many words, because a balance that silently stops moving is the
least answerable complaint a scheme like this can generate.

A flag the browser reads and the crediting function ignores would be a switch
that changes a label and nothing else -- worse than no switch, because an
operator would believe earning had stopped while the ledger carried on. So
`record_coin_intervals` checks it and returns `paused: true`, crediting nothing,
and the browser turns it into a blocker so no time accrues locally either.
Time spent during a pause is **not** banked and paid out afterwards; that would
make "paused" mean "delayed".

Absent means active. A browser that has never fetched the state, and a database
older than the switch, both read as running normally -- "not yet known" is not
"paused", and showing the second when the first is true tells somebody their
time is being thrown away when it is not.

**Setting `coin_to_usd` is a claim about money.** The rest of this feature is
carefully worded as points with no cash value; publishing a dollar rate is a
different statement, and the one regulators look at. The page keeps
"indicative only, cannot be redeemed or exchanged during pre-launch" beside it,
but that wording is not a substitute for advice. Leave it null until you have
some.

## Verification

```bash
npm run typecheck && npx eslint src && npx vitest run
SB=<management token> python supabase/coinProbe.py
```

Check the Google handshake without leaving the terminal — it must **not** end at
`redirect_uri_mismatch`:

```bash
curl -sI "https://edsuuwzihojdsmgzhzyw.supabase.co/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2F127.0.0.1%3A9999%2Fcallback" | grep -i location
```

`coinProbe.py` creates a real user through the auth admin API, signs in, attacks
the ledger 27 ways through PostgREST, and deletes the user. It asserts the
cleanup left nothing behind.
