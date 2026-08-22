-- Encrypted sync storage.
--
-- Deliberately holds ciphertext and nothing else. See ../../docs/sync.md in the
-- browser repository for the protocol and for what is and is not visible here.

create table sync_accounts (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  -- Written once by the first device and never overwritten: changing it would
  -- strand every device already deriving its key from the old salt.
  salt         text not null default '',
  verifier     text not null default '',
  created_at   timestamptz not null default now()
);

create table sync_items (
  account_id uuid not null references sync_accounts (id) on delete cascade,
  collection text not null check (collection in ('bookmarks', 'reading')),
  item_id    text not null,
  -- Unix ms from the device, not now(). It is what the merge orders on, and a
  -- server clock would reorder edits made on a machine whose clock differs.
  updated_at bigint not null,
  deleted    boolean not null default false,
  -- Base64 of iv | tag | ciphertext. Opaque here, and must stay that way.
  payload    text not null default '',
  primary key (account_id, collection, item_id)
);
create index sync_items_cursor on sync_items (account_id, updated_at);

alter table sync_accounts enable row level security;
alter table sync_items enable row level security;

-- An account may only ever see its own rows. This is the entire access control
-- story for sync, so it is worth reading twice.
create policy sync_accounts_own on sync_accounts
  for all to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

create policy sync_items_own on sync_items
  for all to authenticated
  using (
    exists (
      select 1 from sync_accounts a
      where a.id = sync_items.account_id and a.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from sync_accounts a
      where a.id = sync_items.account_id and a.auth_user_id = auth.uid()
    )
  );

revoke all on sync_accounts from anon, authenticated;
revoke all on sync_items from anon, authenticated;
grant select, insert, update on sync_accounts to authenticated;
grant select, insert, update, delete on sync_items to authenticated;

-- Upserts a batch, keeping whichever version is newer.
--
-- A function rather than repeated upserts from the app so the "newer wins" rule
-- lives in one place. A client that could overwrite a newer row with an older
-- one would silently undo edits made on another device.
create or replace function public.sync_push(account uuid, entries jsonb)
returns integer
language plpgsql
security invoker
as $$
declare
  written integer := 0;
begin
  insert into sync_items (account_id, collection, item_id, updated_at, deleted, payload)
  select account,
         e ->> 'collection',
         e ->> 'id',
         (e ->> 'updatedAt')::bigint,
         (e ->> 'deleted')::boolean,
         coalesce(e ->> 'payload', '')
  from jsonb_array_elements(entries) e
  on conflict (account_id, collection, item_id) do update
    set updated_at = excluded.updated_at,
        deleted    = excluded.deleted,
        payload    = excluded.payload
    where excluded.updated_at > sync_items.updated_at;

  get diagnostics written = row_count;
  return written;
end;
$$;
