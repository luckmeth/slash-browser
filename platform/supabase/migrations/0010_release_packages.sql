-- ---------------------------------------------------------------------------
-- RELEASES: the package, and the checksum that makes it installable
--
-- A release was a version and a page to read about it, because the browser
-- could only ever *tell* somebody an update existed: it is not code-signed, and
-- an auto-installer with nothing to verify against is an unauthenticated way to
-- put code on a machine.
--
-- These three columns are what let it do more than tell them, without
-- pretending the signature problem is solved. The browser fetches `file_url`,
-- hashes the bytes as they arrive, and refuses -- deleting the file -- unless
-- they match `sha512`. That gives **integrity**: the package is the one that
-- was published here, and no proxy or mirror can substitute another.
--
-- It does not give authenticity independent of this server, because whoever
-- controls this table controls both the file and the checksum. Code signing is
-- what fixes that, and the signed install path in the browser is untouched and
-- waiting for a certificate.
--
-- All three are optional. A release with only a version and a page is exactly
-- what it was before, and every browser still understands it.
-- ---------------------------------------------------------------------------

alter table releases
  add column if not exists file_url   text not null default '',
  add column if not exists sha512     text not null default '',
  add column if not exists size_bytes bigint not null default 0;

do $$
begin
  -- https only, and only where the browser will fetch an executable from: the
  -- host serving the feed, or a GitHub release asset. The browser enforces
  -- this too; here it stops a bad row being stored in the first place.
  if not exists (select 1 from pg_constraint where conname = 'releases_file_url_https') then
    alter table releases add constraint releases_file_url_https
      check (file_url = '' or file_url ~* '^https://');
  end if;
  -- Hex or base64, which are the two forms a SHA-512 is published in. The
  -- browser normalises both to hex before comparing.
  if not exists (select 1 from pg_constraint where conname = 'releases_sha512_shape') then
    alter table releases add constraint releases_sha512_shape
      check (sha512 = '' or sha512 ~ '^[0-9a-fA-F]{128}$' or sha512 ~ '^[A-Za-z0-9+/]{86}==$');
  end if;
  -- A package without a checksum is one the browser will refuse to run, so it
  -- is refused here instead of being served and rejected later.
  if not exists (select 1 from pg_constraint where conname = 'releases_package_complete') then
    alter table releases add constraint releases_package_complete
      check ((file_url = '') = (sha512 = ''));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'releases_size_plausible') then
    alter table releases add constraint releases_size_plausible
      check (size_bytes >= 0 and size_bytes <= 1073741824);
  end if;
end $$;

comment on column releases.sha512 is
  'SHA-512 of the package, hex or base64. The browser verifies the download against it and deletes a mismatch. It is integrity, not authenticity: whoever can change this row can change both the file and this value.';
