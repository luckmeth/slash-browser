-- Published releases, which is what the browser's update check reads.
--
-- The browser fetches one URL and expects `{ version, releaseUrl }`. Serving
-- that from a table rather than a hand-edited file on a web server is the whole
-- point of having an operations app: publishing a version becomes a form, and
-- there is a record of what was published when.

create table releases (
  id           uuid primary key default gen_random_uuid(),
  -- Semver, compared by the browser against its own app.getVersion().
  version      text not null,
  -- Where a person goes to read about it and download it by hand. Required:
  -- an unsigned build cannot install for itself, so this link IS the update
  -- path until a certificate exists.
  release_url  text not null check (release_url ~* '^https://'),
  notes        text not null default '',
  channel      text not null default 'stable' check (channel in ('stable', 'beta')),
  -- Only one release per channel is served: the newest published one. Kept as a
  -- flag rather than deleting rows, so a bad release can be pulled and the
  -- previous one starts being served again immediately.
  published    boolean not null default false,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users (id),
  unique (channel, version)
);
create index releases_serving on releases (channel, published, published_at desc);

alter table releases enable row level security;

-- Read by nobody through this API directly -- the public feed endpoint uses the
-- service role and serves only the single newest published row per channel.
-- Operators need to see the whole list.
create policy releases_admin on releases
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on releases from anon, authenticated;
grant select, insert, update, delete on releases to authenticated;

-- Publishing one unpublishes the rest of its channel.
--
-- Done in a trigger rather than in the app because "exactly one live release per
-- channel" is an invariant, and an invariant enforced by remembering to call
-- something is not enforced.
create or replace function public.releases_single_live()
returns trigger
language plpgsql
as $$
begin
  if new.published then
    update releases
       set published = false
     where channel = new.channel
       and id <> new.id
       and published;
    if new.published_at is null then
      new.published_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger releases_one_live
  before insert or update on releases
  for each row execute function public.releases_single_live();
