-- ---------------------------------------------------------------------------
-- LEAST PRIVILEGE: taking back grants nobody noticed were given
--
-- Supabase grants `anon` and `authenticated` ALL PRIVILEGES on every new table
-- in `public` by default. The platform migrations knew that and revoked them
-- (`revoke all on campaigns from authenticated, anon`, then column-scoped
-- grants). The Slash Coin migration did not — so `anon` held
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on `profiles`,
-- `coin_balances`, `coin_intervals`, `devices` and `coin_config`.
--
-- **Row-level security was covering it, and that is the problem.** The row
-- policies do refuse every insert, update and delete an unauthenticated caller
-- could make through PostgREST, and no exploit is known through that path. But
-- two things make this worth fixing rather than explaining away:
--
--  1. **TRUNCATE is not subject to row-level security.** It is a table-level
--     privilege. A role holding it empties the table whatever the policies say.
--     PostgREST never emits TRUNCATE, so it is not reachable with an anon key
--     today — it is reachable by anything that ever speaks SQL as that role.
--  2. Every one of those tables was then one missing policy away from being
--     writable by the public. Defence that depends on remembering to write a
--     policy for each of five commands on each of five tables is defence that
--     will eventually be forgotten.
--
-- So the grants are taken back to what is actually used, and the default is
-- changed so the next table does not repeat it.
-- ---------------------------------------------------------------------------

revoke all on profiles       from anon, authenticated;
revoke all on coin_balances  from anon, authenticated;
revoke all on coin_intervals from anon, authenticated;
revoke all on devices        from anon, authenticated;
revoke all on coin_config    from anon, authenticated;

-- What is genuinely read directly, and nothing else. Every write goes through a
-- security-definer function (`save_coin_profile`, `record_coin_intervals`,
-- `request_payout`, `mark_browser_account`), which runs as the owner and is
-- unaffected by these revocations — that is the whole point of the design.
grant select on profiles       to authenticated;
grant select on coin_balances  to authenticated;
grant select on coin_intervals to authenticated;
grant select on devices        to authenticated;

-- The rates, the daily maximum and the launch date are public by design: the
-- browser shows them to somebody deciding whether to opt in at all.
grant select on coin_config to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The update feed, column by column.
--
-- Published releases have to be readable without signing in — that is what
-- makes the feed a feed. `created_by` is an operator's auth user id and has no
-- business being in it, so the grant names the columns rather than the table.
-- PostgREST honours column grants, so a request for `created_by` is refused
-- rather than quietly returned.
-- ---------------------------------------------------------------------------

revoke all on releases from anon;
grant select (version, release_url, notes, channel, published, published_at,
              file_url, sha512, size_bytes)
  on releases to anon;

-- ---------------------------------------------------------------------------
-- The scheduled job is not a public endpoint.
--
-- `advance_campaign_states` moves campaigns across their own start and end
-- times. It was executable by `anon`, which today is close to harmless — it
-- only touches rows whose times have already passed, so an unauthenticated
-- caller can do no more than the cron would do a minute later. It stops being
-- harmless the first time it gains a side effect: an email, a charge, a
-- delivery write. The cron route uses the service role, which is unaffected.
-- ---------------------------------------------------------------------------

revoke execute on function public.advance_campaign_states() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- And the reason it happened, fixed once.
--
-- New tables in `public` will no longer arrive with ALL granted to the two
-- public roles. Every future migration has to say what it is exposing, which is
-- the same discipline the platform migrations already follow — and the failure
-- mode flips from "silently public" to "visibly refused", which is the right
-- way round.
-- ---------------------------------------------------------------------------

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon;
