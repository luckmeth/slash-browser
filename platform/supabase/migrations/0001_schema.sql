-- Slash advertising platform — schema.
--
-- Run against a fresh Supabase project, in filename order, from
-- platform/supabase/migrations. See platform/README.md for how.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table advertisers (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null unique references auth.users (id) on delete cascade,
  company_name  text not null check (length(trim(company_name)) between 1 and 120),
  contact_email text not null,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now()
);
create index advertisers_auth_user on advertisers (auth_user_id);

-- Membership, not a role column on advertisers. An admin is a different kind of
-- account entirely; making it a flag on the advertiser row is how a compromised
-- advertiser session eventually becomes an admin one.
create table admin_users (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  role         text not null default 'admin' check (role in ('admin', 'owner')),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------

-- What each placement costs per hour. Read by the public landing page, so the
-- advertised price and the charged price cannot drift apart.
create table pricing_config (
  id             uuid primary key default gen_random_uuid(),
  placement_tier text not null unique,
  display_name   text not null,
  description    text not null default '',
  hourly_rate    numeric(10, 2) not null check (hourly_rate >= 0),
  -- Sold in whole blocks. A minimum stops one-hour buys that cost more in
  -- Stripe fees than they earn and — because a batch is only fetched every six
  -- hours — keeps every purchased hour long enough to actually be delivered.
  min_hours      integer not null default 24 check (min_hours >= 1),
  -- Concurrency cap. Every live creative's image ships inline in the batch, so
  -- the number running at once is literally the download every reader takes.
  max_concurrent integer not null default 8 check (max_concurrent >= 1),
  active         boolean not null default true,
  updated_by     uuid references auth.users (id),
  updated_at     timestamptz not null default now()
);

-- Every rate change, kept forever. Answers "what was this campaign charged?"
-- long after the rate itself moved on.
create table price_history (
  id             uuid primary key default gen_random_uuid(),
  placement_tier text not null,
  hourly_rate    numeric(10, 2) not null,
  changed_by     uuid references auth.users (id),
  changed_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------

create table campaigns (
  id               uuid primary key default gen_random_uuid(),
  advertiser_id    uuid not null references advertisers (id) on delete cascade,
  title            text not null check (length(trim(title)) between 1 and 200),
  description      text not null default '' check (length(description) <= 400),
  destination_link text not null check (destination_link ~* '^https://'),
  -- Path inside the campaign-assets storage bucket. Converted to a data: URL
  -- when the batch is built — the browser refuses a remote image outright,
  -- because fetching one would be a request to us on every single impression.
  image_path       text,
  placement_tier   text not null references pricing_config (placement_tier),

  -- Set by trigger from pricing_config, never by the client. A price that
  -- arrives from a browser is a price somebody can edit.
  hourly_rate_snapshot numeric(10, 2) not null default 0,
  total_hours          numeric(10, 2) not null default 0,
  total_cost           numeric(10, 2) not null default 0,

  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'pending_review', 'scheduled', 'active',
                      'rejected', 'completed', 'cancelled')),
  review_note text,

  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaign_window_ordered check (ends_at > starts_at)
);
create index campaigns_advertiser on campaigns (advertiser_id, created_at desc);
create index campaigns_status on campaigns (status);
-- The index the batch endpoint runs on, every few hours, from every browser.
create index campaigns_live on campaigns (status, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------

create table payments (
  id                       uuid primary key default gen_random_uuid(),
  campaign_id              uuid not null references campaigns (id) on delete cascade,
  advertiser_id            uuid not null references advertisers (id) on delete cascade,
  amount                   numeric(10, 2) not null,
  currency                 text not null default 'usd',
  stripe_checkout_session  text unique,
  stripe_payment_intent_id text,
  status                   text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  created_at timestamptz not null default now(),
  paid_at    timestamptz
);
create index payments_campaign on payments (campaign_id);
create index payments_advertiser on payments (advertiser_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Delivery numbers
-- ---------------------------------------------------------------------------

-- What browsers report back: per campaign, per day, and nothing finer. This is
-- the whole of what can be known, because it is the whole of what is sent.
--
-- Indicative, not auditable: counts arrive aggregated and hours late, and a
-- browser that is never reopened never reports at all. Show these to an
-- advertiser; do not invoice from them. Hours live is what is billed.
create table delivery_counts (
  campaign_id uuid not null references campaigns (id) on delete cascade,
  day         date not null,
  impressions bigint not null default 0,
  clicks      bigint not null default 0,
  primary key (campaign_id, day)
);

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

-- Operator settings. NOT for the Stripe secret key or the webhook signing
-- secret: those live in the host's encrypted environment. A secret in a table
-- is only as protected as the key encrypting it, and that key has to live in an
-- env var anyway — so putting it here buys a second copy of the secret and no
-- safety. Publishable key, live/test mode and anything else non-secret belong
-- here, where an operator can change them without a deploy.
create table platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

-- Remote config the browser polls. Public by design — every copy of Slash reads
-- it unauthenticated, so nothing may be put here that is not already public.
create table browser_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

create table email_log (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  recipient   text not null,
  campaign_id uuid references campaigns (id) on delete set null,
  status      text not null default 'sent' check (status in ('sent', 'failed')),
  error       text,
  sent_at     timestamptz not null default now()
);
create index email_log_sent on email_log (sent_at desc);
