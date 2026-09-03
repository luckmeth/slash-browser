-- ---------------------------------------------------------------------------
-- COLLECTOR PROFILES, and where a payout would go
--
-- A Slash Coin account was an email address and a balance. Paying anybody
-- anything eventually needs more than that: a name, a date of birth, an
-- address, a country, a phone number, and the wallet a payout would be sent
-- to.
--
-- Three things this schema is careful about, because this is the first
-- personal data the project has stored about the people using the browser.
--
-- **It is theirs, and it is not readable by anybody else.** Row-level security
-- already restricts `profiles` to `id = auth.uid() or is_admin()`. Every
-- column added here inherits that. No policy anywhere lets one collector read
-- another, and nothing in the browser sends a profile to a third party.
--
-- **The client cannot write anything that matters.** The write path is one
-- security-definer function that touches exactly these columns. `suspended`,
-- `email`, `created_at` and the whole ledger are unreachable through it, so a
-- forged request can change somebody's address and nothing else.
--
-- **A wallet address is stored, never validated as ownership.** Storing an
-- address is not proof anybody controls it, and this schema does not pretend
-- otherwise: `wallet_verified_at` exists and stays null until something
-- actually verifies it. A payout process that trusts an unverified address is
-- a payout process that pays whoever typed last.
-- ---------------------------------------------------------------------------

alter table profiles
  add column if not exists full_name          text not null default '',
  add column if not exists date_of_birth      date,
  add column if not exists address_line1      text not null default '',
  add column if not exists address_line2      text not null default '',
  add column if not exists city               text not null default '',
  add column if not exists region             text not null default '',
  add column if not exists postcode           text not null default '',
  -- ISO 3166-1 alpha-2, upper case. Two letters, or empty for not answered.
  add column if not exists country            text not null default '',
  add column if not exists phone              text not null default '',
  add column if not exists wallet_address     text not null default '',
  add column if not exists wallet_network     text not null default '',
  add column if not exists wallet_verified_at timestamptz,
  -- Whether they want anything beyond the messages the service has to send.
  -- Default false, because somebody who signed up to a rewards scheme expects
  -- to hear about the rewards scheme -- but it exists, it is theirs to set
  -- from the browser, and the operator broadcast honours it. A bulk send with
  -- no way out is the thing that gets a sending domain blocked.
  add column if not exists email_opt_out boolean not null default false,
  add column if not exists profile_updated_at timestamptz;

-- Constraints as a second line, after the columns exist. Each one is a bound
-- on a field a client controls; the pure validator in the browser gives the
-- same answers in readable sentences, and this is what holds if it is wrong.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_country_shape') then
    alter table profiles add constraint profiles_country_shape
      check (country = '' or country ~ '^[A-Z]{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_wallet_network_known') then
    alter table profiles add constraint profiles_wallet_network_known
      check (wallet_network in ('', 'ethereum', 'polygon', 'bsc', 'solana', 'tron', 'bitcoin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_text_lengths') then
    alter table profiles add constraint profiles_text_lengths
      check (
        length(full_name) <= 120 and
        length(address_line1) <= 160 and
        length(address_line2) <= 160 and
        length(city) <= 80 and
        length(region) <= 80 and
        length(postcode) <= 24 and
        length(phone) <= 32 and
        length(wallet_address) <= 128
      );
  end if;
  -- A date of birth that has not happened, or one implying a lifespan nobody
  -- has had, is a typo rather than a person.
  if not exists (select 1 from pg_constraint where conname = 'profiles_dob_plausible') then
    alter table profiles add constraint profiles_dob_plausible
      check (date_of_birth is null or (date_of_birth > date '1900-01-01' and date_of_birth < current_date));
  end if;
end $$;

comment on column profiles.wallet_address is
  'Where a payout would be sent. Storing an address is not proof of control of it - see wallet_verified_at, which stays null until something verifies that.';
comment on column profiles.profile_updated_at is
  'When the collector last saved their details. NULL means they never have, which is what the browser asks about after a first sign-in.';

-- ---------------------------------------------------------------------------
-- Reading your own profile.
--
-- A function rather than a select, so the browser has one call whose shape is
-- fixed here: adding a column to `profiles` cannot silently start returning it
-- to every client.
-- ---------------------------------------------------------------------------
create or replace function public.coin_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  p   profiles%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into p from profiles where id = uid;
  if not found then
    -- Signed in but with no ledger activity yet, so no row exists. An empty
    -- profile is the honest answer; the browser shows an empty form.
    return jsonb_build_object(
      'email', coalesce((select u.email from auth.users u where u.id = uid), ''),
      'complete', false
    );
  end if;

  return jsonb_build_object(
    'email',            p.email,
    'fullName',         p.full_name,
    'dateOfBirth',      p.date_of_birth,
    'addressLine1',     p.address_line1,
    'addressLine2',     p.address_line2,
    'city',             p.city,
    'region',           p.region,
    'postcode',         p.postcode,
    'country',          p.country,
    'phone',            p.phone,
    'walletAddress',    p.wallet_address,
    'walletNetwork',    p.wallet_network,
    'walletVerified',   p.wallet_verified_at is not null,
    'emailOptOut',      p.email_opt_out,
    'updatedAt',        case when p.profile_updated_at is null then null
                        else extract(epoch from p.profile_updated_at) * 1000 end,
    'complete',         p.profile_updated_at is not null
  );
end;
$function$;

revoke all on function public.coin_profile() from public, anon;
grant execute on function public.coin_profile() to authenticated;

-- ---------------------------------------------------------------------------
-- Saving it.
--
-- The only write path. It takes one jsonb object, reads the keys it knows and
-- ignores everything else, so a client sending `{"suspended": false}` changes
-- nothing at all rather than being refused with a message that teaches it what
-- to try next.
--
-- The email is **not** taken from the request. It is read from `auth.users`,
-- which is the account that signed in with Google — a client that could set
-- its own contact address could redirect somebody else's payout notice.
-- ---------------------------------------------------------------------------
create or replace function public.save_coin_profile(details jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid   uuid := auth.uid();
  mail  text;
  v_dob date;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(details) <> 'object' then
    raise exception 'details must be an object' using errcode = '22023';
  end if;

  mail := coalesce((select u.email from auth.users u where u.id = uid), '');

  -- An empty string means "not answered" and must not become an invalid date.
  if coalesce(details ->> 'dateOfBirth', '') = '' then
    v_dob := null;
  else
    v_dob := (details ->> 'dateOfBirth')::date;
  end if;

  insert into profiles (id, email)
  values (uid, mail)
  on conflict (id) do nothing;

  update profiles set
    email              = case when email = '' then mail else email end,
    full_name          = left(trim(coalesce(details ->> 'fullName', full_name)), 120),
    date_of_birth      = v_dob,
    address_line1      = left(trim(coalesce(details ->> 'addressLine1', address_line1)), 160),
    address_line2      = left(trim(coalesce(details ->> 'addressLine2', address_line2)), 160),
    city               = left(trim(coalesce(details ->> 'city', city)), 80),
    region             = left(trim(coalesce(details ->> 'region', region)), 80),
    postcode           = left(trim(coalesce(details ->> 'postcode', postcode)), 24),
    country            = upper(left(trim(coalesce(details ->> 'country', country)), 2)),
    phone              = left(trim(coalesce(details ->> 'phone', phone)), 32),
    wallet_address     = left(trim(coalesce(details ->> 'walletAddress', wallet_address)), 128),
    wallet_network     = lower(trim(coalesce(details ->> 'walletNetwork', wallet_network))),
    email_opt_out      = coalesce((details ->> 'emailOptOut')::boolean, email_opt_out),
    -- Changing the address invalidates any verification of the old one. This
    -- is the single most valuable field to an attacker who gets a session.
    wallet_verified_at = case
      when left(trim(coalesce(details ->> 'walletAddress', wallet_address)), 128) is distinct from wallet_address
      then null else wallet_verified_at end,
    profile_updated_at = now()
  where id = uid;

  return public.coin_profile();
end;
$function$;

revoke all on function public.save_coin_profile(jsonb) from public, anon;
grant execute on function public.save_coin_profile(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The advertiser side: a company profile.
--
-- `advertisers` held a company name and a contact email, which is enough to
-- take a campaign and not enough to put a company in front of readers or to
-- send it an invoice. These are the rest, and they are all fields the
-- advertiser fills in about themselves — `advertisers_update_own` already
-- lets them, and `is_admin()` already lets an operator read them.
-- ---------------------------------------------------------------------------
alter table advertisers
  add column if not exists email_opt_out  boolean not null default false,
  add column if not exists website        text not null default '',
  add column if not exists description    text not null default '',
  add column if not exists contact_name   text not null default '',
  add column if not exists contact_phone  text not null default '',
  add column if not exists address_line1  text not null default '',
  add column if not exists city           text not null default '',
  add column if not exists postcode       text not null default '',
  add column if not exists country        text not null default '',
  add column if not exists tax_id         text not null default '',
  add column if not exists logo_path      text not null default '',
  add column if not exists profile_updated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'advertisers_country_shape') then
    alter table advertisers add constraint advertisers_country_shape
      check (country = '' or country ~ '^[A-Z]{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'advertisers_text_lengths') then
    alter table advertisers add constraint advertisers_text_lengths
      check (
        length(website) <= 200 and
        length(description) <= 600 and
        length(contact_name) <= 120 and
        length(contact_phone) <= 32 and
        length(address_line1) <= 160 and
        length(city) <= 80 and
        length(postcode) <= 24 and
        length(tax_id) <= 40
      );
  end if;
end $$;

-- The columns an advertiser may write are exactly the ones above: `status` is
-- an operator decision and is protected by its own check, because
-- `advertisers_update_own` allows an update to the row and would otherwise
-- allow a suspended advertiser to un-suspend themselves.
drop policy if exists advertisers_update_own on advertisers;
create policy advertisers_update_own on advertisers
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (
    auth_user_id = auth.uid()
    and status = (select a.status from advertisers a where a.auth_user_id = auth.uid())
  );

grant update (
  company_name, contact_email, website, description, contact_name, contact_phone,
  address_line1, city, postcode, country, tax_id, logo_path, profile_updated_at
) on advertisers to authenticated;
