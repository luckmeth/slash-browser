/**
 * Forward-only schema migrations.
 *
 * Migrations are TypeScript modules rather than .sql files on purpose: rollup
 * bundles them into the main entry, so they cannot go missing inside an asar
 * archive the way a loose .sql file read at runtime would.
 *
 * Rules:
 *  - Append only. Never edit a migration that has shipped.
 *  - `version` is contiguous starting at 1 and matches `PRAGMA user_version`.
 *  - Each migration runs inside a transaction; a throw rolls the whole step back.
 */

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

const m001_init: Migration = {
  version: 1,
  name: 'init',
  sql: /* sql */ `
    -- Settings live as a single JSON row parsed through SettingsSchema. Adding a
    -- setting is then a schema change in TypeScript with a default, not a DDL
    -- migration, which keeps the two definitions from drifting apart.
    CREATE TABLE app_settings (
      id   INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT    NOT NULL
    );

    -- Spike B evidence table. A write and read-back through this table from the
    -- packaged app proves the native module loaded against the Electron ABI and
    -- that userData is writable from an installed build.
    CREATE TABLE diagnostics_probe (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      note       TEXT    NOT NULL
    );
  `
}

const m002_browsing: Migration = {
  version: 2,
  name: 'browsing',
  sql: /* sql */ `
    -- One row per URL with a visit counter, not one row per visit. Every history
    -- read is "pages I've been to, most recent first", which a visit log would
    -- force through a GROUP BY. Phase 6 keeps its own session snapshots, so
    -- visit-level granularity is not lost from the product as a whole.
    CREATE TABLE history_visits (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT    NOT NULL UNIQUE,
      title           TEXT    NOT NULL DEFAULT '',
      favicon_url     TEXT,
      visit_count     INTEGER NOT NULL DEFAULT 1,
      last_visited_at INTEGER NOT NULL
    );
    -- The default listing is ORDER BY last_visited_at DESC; DESC in the index
    -- lets SQLite walk it directly instead of sorting.
    CREATE INDEX idx_history_last_visited ON history_visits (last_visited_at DESC);
    CREATE INDEX idx_history_title ON history_visits (title);

    -- Folders are bookmarks with a NULL url and is_folder = 1, so a folder tree
    -- and its leaves live in one table and one ordering column.
    CREATE TABLE bookmarks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT,
      title       TEXT    NOT NULL,
      favicon_url TEXT,
      parent_id   INTEGER REFERENCES bookmarks (id) ON DELETE CASCADE,
      is_folder   INTEGER NOT NULL DEFAULT 0 CHECK (is_folder IN (0, 1)),
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      -- A folder must not carry a url, and a bookmark must have one.
      CHECK ((is_folder = 1 AND url IS NULL) OR (is_folder = 0 AND url IS NOT NULL))
    );
    CREATE INDEX idx_bookmarks_parent ON bookmarks (parent_id, sort_order);
    CREATE INDEX idx_bookmarks_url ON bookmarks (url);

    -- Downloads persist across restarts so the list survives a quit mid-transfer.
    -- Electron cannot resume a download after the process exits, so anything left
    -- 'progressing' or 'paused' at startup is reconciled to 'interrupted'.
    CREATE TABLE downloads (
      id             TEXT    PRIMARY KEY,
      url            TEXT    NOT NULL,
      filename       TEXT    NOT NULL,
      save_path      TEXT    NOT NULL,
      mime_type      TEXT    NOT NULL DEFAULT '',
      total_bytes    INTEGER NOT NULL DEFAULT -1,
      received_bytes INTEGER NOT NULL DEFAULT 0,
      state          TEXT    NOT NULL,
      is_dangerous   INTEGER NOT NULL DEFAULT 0 CHECK (is_dangerous IN (0, 1)),
      started_at     INTEGER NOT NULL,
      completed_at   INTEGER
    );
    CREATE INDEX idx_downloads_started ON downloads (started_at DESC);
  `
}

const m003_workspaces: Migration = {
  version: 3,
  name: 'workspaces',
  sql: /* sql */ `
    CREATE TABLE workspaces (
      id         TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      icon       TEXT    NOT NULL DEFAULT '',
      color      TEXT    NOT NULL DEFAULT 'slate',
      -- Fixed at creation: an isolated workspace owns a persist: partition, and
      -- flipping this later would strand every cookie in the old partition.
      isolated   INTEGER NOT NULL DEFAULT 0 CHECK (isolated IN (0, 1)),
      notes      TEXT    NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- There must always be somewhere for a tab to live, so the default workspace
    -- is seeded by the migration rather than created lazily at runtime.
    INSERT INTO workspaces (id, name, icon, color, isolated, notes, sort_order, created_at)
    VALUES ('default', 'Personal', 'wsHome', 'blue', 0, '', 0, unixepoch() * 1000);
  `
}

const m004_permissions: Migration = {
  version: 4,
  name: 'permissions',
  sql: /* sql */ `
    -- Only decisions that outlive the process are stored. allow-once,
    -- allow-for-tab and allow-for-session are deliberately memory-only: writing
    -- them would turn a deliberately temporary grant into a durable one, which
    -- is the opposite of what the user chose.
    --
    -- Keyed by partition as well as origin, so an isolated workspace's grants
    -- cannot leak into the shared session or into another workspace.
    CREATE TABLE permission_grants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      partition  TEXT    NOT NULL,
      origin     TEXT    NOT NULL,
      kind       TEXT    NOT NULL,
      policy     TEXT    NOT NULL,
      expires_at INTEGER,
      tab_id     TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (partition, origin, kind)
    );
    CREATE INDEX idx_grants_lookup ON permission_grants (partition, origin, kind);
    CREATE INDEX idx_grants_expiry ON permission_grants (expires_at)
      WHERE expires_at IS NOT NULL;

    -- Append-only activity log. Never updated, never deleted by normal use:
    -- "what did I agree to, and when" is only trustworthy if the record cannot
    -- be quietly rewritten. Clearing it is an explicit user action.
    CREATE TABLE permission_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      partition TEXT    NOT NULL,
      origin    TEXT    NOT NULL,
      kind      TEXT    NOT NULL,
      action    TEXT    NOT NULL,
      policy    TEXT,
      at        INTEGER NOT NULL
    );
    CREATE INDEX idx_permission_events_at ON permission_events (at DESC);
  `
}

const m005_snapshots: Migration = {
  version: 5,
  name: 'snapshots',
  sql: /* sql */ `
    CREATE TABLE snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT    NOT NULL,
      kind       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_snapshots_created ON snapshots (created_at DESC);
    CREATE INDEX idx_snapshots_kind ON snapshots (kind, created_at DESC);

    -- Tabs are stored per snapshot rather than deduplicated across snapshots.
    -- A snapshot has to be a complete, independent record: sharing rows would
    -- mean pruning one restore point could corrupt another, and correctness of
    -- recovery matters far more here than the few kilobytes saved.
    --
    -- entries_json holds the back/forward list. It carries pageState (scroll and
    -- form values) only when the user has opted in — see restoreFormState.
    CREATE TABLE snapshot_tabs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id        INTEGER NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
      url                TEXT    NOT NULL,
      title              TEXT    NOT NULL DEFAULT '',
      favicon_url        TEXT,
      workspace_id       TEXT    NOT NULL,
      tab_order          INTEGER NOT NULL,
      is_pinned          INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
      scroll_y           REAL    NOT NULL DEFAULT 0,
      entries_json       TEXT    NOT NULL DEFAULT '[]',
      active_entry_index INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_snapshot_tabs ON snapshot_tabs (snapshot_id, tab_order);
  `
}

const m006_memory: Migration = {
  version: 6,
  name: 'memory',
  sql: /* sql */ `
    -- One row per indexed page. Metadata only; the searchable text lives in the
    -- FTS table so there is exactly one copy of it.
    CREATE TABLE memory_pages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT    NOT NULL UNIQUE,
      title       TEXT    NOT NULL DEFAULT '',
      site_name   TEXT,
      excerpt     TEXT    NOT NULL DEFAULT '',
      word_count  INTEGER NOT NULL DEFAULT 0,
      /** Whether body text was stored, or only title and URL. */
      has_content INTEGER NOT NULL DEFAULT 0 CHECK (has_content IN (0, 1)),
      indexed_at  INTEGER NOT NULL,
      visited_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_memory_visited ON memory_pages (visited_at DESC);

    -- FTS5 with the porter stemmer, so "scaling" finds "scale". BM25 ranking is
    -- built in, which is what makes results ordered by relevance rather than by
    -- how many times a word happens to appear.
    --
    -- The text is stored in the FTS table itself rather than in an external
    -- content table: it keeps snippet() working without a join, and there is
    -- only ever one copy to delete when the user forgets a page.
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      title,
      body,
      url,
      page_id UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `
}

const m007_ai: Migration = {
  version: 7,
  name: 'ai',
  sql: /* sql */ `
    -- The API key, encrypted by the OS keychain (DPAPI on Windows) before it
    -- reaches this table. A BLOB, not TEXT: it is ciphertext, and storing a
    -- provider key in readable form next to the browsing history would be
    -- indefensible.
    CREATE TABLE ai_secrets (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      api_key BLOB NOT NULL
    );

    -- Every proposal and every execution, so "what did the AI do" is answerable
    -- after the fact rather than a matter of trust.
    CREATE TABLE ai_activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      at            INTEGER NOT NULL,
      request       TEXT    NOT NULL,
      understanding TEXT    NOT NULL DEFAULT '',
      outcome       TEXT    NOT NULL,
      action_count  INTEGER NOT NULL DEFAULT 0,
      detail        TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_ai_activity_at ON ai_activity (at DESC);
  `
}

const m008_icon_names: Migration = {
  version: 8,
  name: 'icon_names',
  sql: /* sql */ `
    -- Workspace icons were emoji; they are now names into the app's SVG set.
    -- Emoji render differently on every platform and read as informal in
    -- application chrome.
    --
    -- Existing rows are mapped by meaning where there is an obvious match, and
    -- anything unrecognised becomes the folder icon rather than a broken glyph.
    UPDATE workspaces SET icon = CASE icon
      WHEN '🏠' THEN 'wsHome'
      WHEN '💼' THEN 'wsWork'
      WHEN '🎓' THEN 'wsStudy'
      WHEN '💻' THEN 'wsCode'
      WHEN '🔬' THEN 'wsResearch'
      WHEN '✈️' THEN 'wsTravel'
      WHEN '🛒' THEN 'wsShop'
      WHEN '🎵' THEN 'wsMedia'
      WHEN '🎨' THEN 'wsDesign'
      WHEN '📚' THEN 'wsReading'
      WHEN '⚡' THEN 'wsFinance'
      WHEN '🕘' THEN 'wsHome'
      WHEN '📁' THEN 'wsFolder'
      ELSE icon
    END;

    -- Anything still not a known name (an emoji we did not list, or a value from
    -- a hand-edited database) is normalised so the UI never has to render an
    -- unknown icon.
    UPDATE workspaces SET icon = 'wsFolder'
    WHERE icon NOT IN (
      'wsHome','wsWork','wsStudy','wsCode','wsResearch','wsTravel',
      'wsShop','wsMedia','wsDesign','wsReading','wsFinance','wsFolder'
    );
  `
}

const m009_closed_tabs: Migration = {
  version: 9,
  name: 'closed_tabs',
  sql: /* sql */ `
    -- Recently-closed tabs, so Ctrl+Shift+T survives a restart.
    --
    -- This lived in a plain array in TabManager, which meant closing the browser
    -- discarded it: the one moment you are most likely to want a tab back is
    -- after reopening, and that was exactly when the list was empty.
    --
    -- Stores what a tab is, not what it was showing: url, title, favicon, where
    -- it sat, and its back/forward history. No page content, no form state.
    CREATE TABLE closed_tabs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT    NOT NULL,
      title         TEXT    NOT NULL DEFAULT '',
      favicon_url   TEXT,
      tab_index     INTEGER NOT NULL DEFAULT 0,
      is_pinned     INTEGER NOT NULL DEFAULT 0,
      workspace_id  TEXT    NOT NULL,
      -- JSON from webContents.navigationHistory, so Back still works on reopen.
      navigation    TEXT    NOT NULL DEFAULT '',
      closed_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_closed_tabs_at ON closed_tabs (closed_at DESC);
  `
}

const m010_semantic: Migration = {
  version: 10,
  name: 'semantic',
  sql: /* sql */ `
    -- Text as the embedding model saw it. Kept rather than recomputed because a
    -- search result quotes the passage that actually matched — reconstructing it
    -- from memory_fts would mean re-running the chunker and hoping it split the
    -- page the same way it did months ago.
    --
    -- ON DELETE CASCADE from memory_pages, so forgetting a page cannot leave its
    -- text behind here. The vectors are the one thing a cascade cannot reach:
    -- vec0 is a virtual table and carries no foreign keys, so VectorStore deletes
    -- those explicitly *before* the page row goes.
    CREATE TABLE memory_chunks (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL REFERENCES memory_pages (id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      text    TEXT    NOT NULL,
      UNIQUE (page_id, ordinal)
    );
    CREATE INDEX idx_memory_chunks_page ON memory_chunks (page_id);

    -- What has been embedded, with what. The hash is of the text that was fed to
    -- the model: re-visiting an unchanged page must not re-embed it, and an
    -- edited page must. The model id is recorded because vectors from two models
    -- are not comparable — changing models invalidates every row here.
    CREATE TABLE memory_embedded_pages (
      page_id      INTEGER PRIMARY KEY REFERENCES memory_pages (id) ON DELETE CASCADE,
      model        TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      chunk_count  INTEGER NOT NULL DEFAULT 0,
      embedded_at  INTEGER NOT NULL
    );

    -- The vec0 virtual table is deliberately NOT created here. It needs the
    -- sqlite-vec extension loaded, and a migration that fails takes the whole
    -- database — and therefore the browser — down with it. Semantic search is
    -- optional; the browser starting is not. VectorStore creates the table the
    -- first time the feature is switched on, by which point a failure has
    -- somewhere honest to be reported.
  `
}

const m011_ai_providers: Migration = {
  version: 11,
  name: 'ai_providers',
  sql: /* sql */ `
    -- One credential row per provider, replacing the single-key table.
    --
    -- The browser supports several AI providers at once, so a single row keyed
    -- \`id = 1\` could only ever hold one of them — connecting a second silently
    -- overwrote the first.
    --
    -- \`api_key\` is a BLOB because it is ciphertext from the OS keychain
    -- (DPAPI on Windows), never readable text. \`model\` and \`base_url\` sit
    -- beside it so each provider keeps its own choice rather than sharing one
    -- global model name that is wrong for three of them.
    CREATE TABLE ai_credentials (
      provider   TEXT    PRIMARY KEY,
      api_key    BLOB,
      model      TEXT    NOT NULL DEFAULT '',
      base_url   TEXT,
      created_at INTEGER NOT NULL
    );

    -- Carry the existing key forward rather than making the user re-enter it.
    -- The old table named no provider, but the only one that could have written
    -- a key while the setting was 'anthropic' is Anthropic, and an unusable key
    -- under the wrong provider is a disconnect away from being fixed.
    INSERT INTO ai_credentials (provider, api_key, model, base_url, created_at)
    SELECT 'anthropic', api_key, '', NULL, unixepoch() * 1000
    FROM ai_secrets WHERE id = 1;
  `
}

const m012_crashes: Migration = {
  version: 12,
  name: 'crashes',
  sql: /* sql */ `
    -- What crashed, when, and which process. Nothing about the page itself.
    --
    -- A URL is deliberately NOT recorded: a crash log that accumulates the
    -- addresses of pages the user visited is a browsing history under another
    -- name, and it would survive "delete my history". The reason a renderer died
    -- is in the dump; where the user was is not our business.
    CREATE TABLE crash_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      -- 'renderer' | 'gpu' | 'utility' | 'main'
      process TEXT    NOT NULL,
      -- Chromium's own reason string: 'crashed', 'oom', 'killed', ...
      reason  TEXT    NOT NULL,
      -- Exit code where one was reported.
      code    INTEGER
    );
    CREATE INDEX idx_crash_events_at ON crash_events (at DESC);
  `
}

const m013_watched_pages: Migration = {
  version: 13,
  name: 'watched_pages',
  sql: /* sql */ `
    -- Pages the user asked to be told about when they change.
    --
    -- Only the *normalised* text of the last visit is kept, not a copy of the
    -- page: the point is to answer "has this changed", which needs one previous
    -- version and no history of them. Keeping every version would turn a change
    -- watcher into an archive of everything the user ever watched.
    CREATE TABLE watched_pages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT    NOT NULL UNIQUE,
      title           TEXT    NOT NULL DEFAULT '',
      added_at        INTEGER NOT NULL,
      last_checked_at INTEGER,
      -- Hash of the normalised text, so an unchanged page costs one comparison.
      last_hash       TEXT    NOT NULL DEFAULT '',
      -- The text itself, needed to say *what* changed rather than only that it did.
      last_text       TEXT    NOT NULL DEFAULT ''
    );

    -- What changed, when. Excerpts are capped: this is a notification, not a
    -- second copy of the page.
    CREATE TABLE page_changes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id   INTEGER NOT NULL REFERENCES watched_pages (id) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      summary   TEXT    NOT NULL,
      -- Up to a few hundred characters each, for a before/after view.
      removed   TEXT    NOT NULL DEFAULT '',
      added     TEXT    NOT NULL DEFAULT '',
      -- Whether the user has seen it, so the badge can clear.
      seen      INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0, 1))
    );
    CREATE INDEX idx_page_changes_page ON page_changes (page_id, at DESC);
  `
}

const m015_tab_groups: Migration = {
  version: 15,
  name: 'tab_groups',
  sql: /* sql */ `
    -- A coloured run of tabs inside one workspace.
    --
    -- Distinct from a workspace, which owns a session partition and a tab list.
    -- A group is presentation: a name and a colour over a run of tabs that are
    -- already in this workspace. Deleting a group therefore never deletes tabs.
    --
    -- Persisted rather than kept in memory because a group that evaporates on
    -- restart is worse than no grouping — the user has spent effort naming and
    -- sorting, and losing it teaches them not to bother.
    CREATE TABLE tab_groups (
      id           TEXT    PRIMARY KEY,
      workspace_id TEXT    NOT NULL,
      name         TEXT    NOT NULL DEFAULT '',
      -- Named colours rather than hex, so the palette stays consistent with the
      -- workspace colours and a theme change repaints groups too.
      color        TEXT    NOT NULL DEFAULT 'blue',
      -- Collapsed hides the group's tabs in the strip. The tabs are untouched:
      -- collapsing is not sleeping, and it must never be mistaken for it.
      collapsed    INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_tab_groups_workspace ON tab_groups (workspace_id, created_at);

    -- Group membership travels with a restored tab, so reopening a session
    -- brings back the arrangement and not just the pages.
    ALTER TABLE snapshot_tabs ADD COLUMN group_id TEXT;
  `
}

const m016_reading_list: Migration = {
  version: 16,
  name: 'reading_list',
  sql: /* sql */ `
    -- Pages saved to read later. Deliberately separate from bookmarks.
    --
    -- A bookmark is a permanent reference you expect to come back to; a reading
    -- list entry is a queue item you expect to consume once and clear. Mixing
    -- them means the queue silently fills the reference library with things you
    -- never wanted to keep, which is exactly why people stop using bookmarks.
    CREATE TABLE reading_list (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      url        TEXT    NOT NULL UNIQUE,
      title      TEXT    NOT NULL DEFAULT '',
      favicon_url TEXT,
      added_at   INTEGER NOT NULL,
      -- Null until read. Kept rather than deleted so "mark as read" is
      -- reversible and the list can show what was finished.
      read_at    INTEGER
    );
    CREATE INDEX idx_reading_list_added ON reading_list (read_at, added_at DESC);
  `
}

const m017_logins: Migration = {
  version: 17,
  name: 'saved_logins',
  sql: /* sql */ `
    -- Saved sign-ins.
    --
    -- The password is stored ONLY as a ciphertext blob produced by Electron's
    -- safeStorage, which on Windows is DPAPI keyed to the user's account. There
    -- is deliberately no plaintext column and no "encrypted" flag: a schema that
    -- can represent an unencrypted password is a schema where one eventually
    -- gets written. If the platform has no secure store, Slash refuses to save
    -- rather than falling back to something readable next to the history file.
    --
    -- The username is NOT encrypted. It is needed to show you which account an
    -- entry is for before anything is unlocked, and it is the half that is
    -- usually printed on the site's own screen anyway.
    CREATE TABLE saved_logins (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Host rather than full URL: a login belongs to a site, not to the page
      -- that happened to show the form.
      host         TEXT    NOT NULL,
      username     TEXT    NOT NULL DEFAULT '',
      password_enc BLOB    NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      UNIQUE (host, username)
    );
    CREATE INDEX idx_saved_logins_host ON saved_logins (host);
  `
}

const m018_sponsored: Migration = {
  version: 18,
  name: 'sponsored_tiles',
  sql: /* sql */ `
    -- A batch of sponsored creatives, fetched ahead of time.
    --
    -- Fetched as a BATCH and chosen from on-device, which is the whole point:
    -- the request that gets them carries no identifier and no browsing data, so
    -- the sponsor learns that a copy of Slash asked for tiles and nothing about
    -- who is running it. Per-impression fetching would leak exactly what this
    -- browser exists to prevent leaking.
    CREATE TABLE sponsored_tiles (
      id          TEXT    PRIMARY KEY,
      sponsor     TEXT    NOT NULL,
      headline    TEXT    NOT NULL,
      body        TEXT    NOT NULL DEFAULT '',
      -- Inlined as a data: URL at fetch time. A remote <img> src would be a
      -- per-impression request to the sponsor's server -- a tracking pixel by
      -- another name -- and would defeat batching entirely.
      image       TEXT    NOT NULL DEFAULT '',
      click_url   TEXT    NOT NULL,
      fetched_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    -- Aggregate counts awaiting report. No timestamps beyond the day, no page,
    -- no session, no identifier -- deliberately not enough to reconstruct when
    -- or where anything was seen.
    CREATE TABLE sponsored_counts (
      tile_id     TEXT    NOT NULL,
      day         TEXT    NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tile_id, day)
    );
  `
}

const m014_missions: Migration = {
  version: 14,
  name: 'missions',
  sql: /* sql */ `
    -- A goal the user is working towards, with the pages and notes that belong
    -- to it. Distinct from a workspace: a workspace is a place to keep tabs, a
    -- mission is a thing you are trying to finish, and one workspace may host
    -- several missions over time.
    CREATE TABLE missions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      goal         TEXT    NOT NULL,
      notes        TEXT    NOT NULL DEFAULT '',
      -- Exactly one mission is active at a time; enforced in the service rather
      -- than by a constraint, because "none active" is also valid.
      active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at   INTEGER NOT NULL,
      completed_at INTEGER
    );

    -- Pages belonging to a mission. 'saved' is the for-later pile — the whole
    -- point of the gentle suggestion is that a digression is kept rather than
    -- blocked.
    CREATE TABLE mission_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
      url        TEXT    NOT NULL,
      title      TEXT    NOT NULL DEFAULT '',
      kind       TEXT    NOT NULL CHECK (kind IN ('page', 'saved')),
      added_at   INTEGER NOT NULL,
      UNIQUE (mission_id, url, kind)
    );
    CREATE INDEX idx_mission_items ON mission_items (mission_id, added_at DESC);
  `
}

const m019_sponsor_schedule: Migration = {
  version: 19,
  name: 'sponsor_schedule',
  sql: /* sql */ `
    -- When a creative may run, as unix ms. NULL at either end means unbounded.
    --
    -- Campaigns are sold by the hour, but a batch is fetched at most every six
    -- hours -- so an hour bought at 14:00 would be invisible to any copy that
    -- last fetched at 13:00, which is most of them. Carrying the window in the
    -- batch lets each machine start and stop the campaign itself, from data it
    -- already has: no extra requests, correct while offline, and nothing about
    -- the reader ever sent to find out whether an advert is due.
    --
    -- Distinct from expires_at, which is when the BATCH goes stale. One is the
    -- campaign's life, the other is the cache's.
    ALTER TABLE sponsored_tiles ADD COLUMN starts_at INTEGER;
    ALTER TABLE sponsored_tiles ADD COLUMN ends_at   INTEGER;
  `
}

const m020_snapshot_windows: Migration = {
  version: 20,
  name: 'snapshot_windows',
  sql: /* sql */ `
    -- Which window a tab was in when the snapshot was taken.
    --
    -- Without it a restore point is a flat list, and restoring two windows of
    -- work produced one window containing everything. Nothing looked broken --
    -- every page came back -- so the only symptom was an arrangement the user
    -- built by hand quietly collapsing, with no way to tell whether the browser
    -- had forgotten it or never recorded it.
    --
    -- Defaults to 0, so every snapshot taken before this migration restores as a
    -- single window, which is exactly what it was.
    ALTER TABLE snapshot_tabs ADD COLUMN window_index INTEGER NOT NULL DEFAULT 0;
  `
}

const m021_sync: Migration = {
  version: 21,
  name: 'sync',
  sql: /* sql */ `
    -- A stable identity for a bookmark, so two machines can agree what "the
    -- same bookmark" is.
    --
    -- The primary key is an AUTOINCREMENT integer, which is unique on this
    -- machine and meaningless anywhere else: two devices creating a bookmark
    -- each would both call it 7. Backfilled with random values for rows that
    -- already exist; new rows get one from the repository.
    ALTER TABLE bookmarks ADD COLUMN guid TEXT;
    UPDATE bookmarks SET guid = lower(hex(randomblob(16))) WHERE guid IS NULL;
    CREATE UNIQUE INDEX idx_bookmarks_guid ON bookmarks (guid);

    -- When each row last changed, which is the only ordering a last-write-wins
    -- merge has. Seeded from creation time: a row nobody has touched since it
    -- was made was, in fact, last changed then.
    ALTER TABLE bookmarks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    UPDATE bookmarks SET updated_at = created_at;

    ALTER TABLE reading_list ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    UPDATE reading_list SET updated_at = added_at;

    -- What was deleted, and when.
    --
    -- Without this a deletion is an absence, and an absence is indistinguishable
    -- from "the other device has something new" — so every bookmark deleted on
    -- one machine comes back the moment another one syncs. Pruned after a long
    -- window; see mergeTombstoneMaxAge.
    CREATE TABLE sync_tombstones (
      collection TEXT    NOT NULL,
      item_id    TEXT    NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (collection, item_id)
    );

    -- One row. Holds this device's identity and how far it has read.
    --
    -- The salt is stored, the passphrase is not, and no key derived from it is
    -- either -- the key is derived on each unlock and held in memory only. The
    -- verifier lets a second device tell a wrong passphrase from an empty
    -- account, which is otherwise indistinguishable.
    CREATE TABLE sync_state (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      device_id     TEXT    NOT NULL,
      cursor        INTEGER NOT NULL DEFAULT 0,
      salt          TEXT    NOT NULL DEFAULT '',
      verifier      TEXT    NOT NULL DEFAULT '',
      last_sync_at  INTEGER,
      last_error    TEXT
    );
  `
}

const m022_addresses: Migration = {
  version: 22,
  name: 'addresses',
  sql: /* sql */ `
    -- Addresses the user chose to save, for filling checkout and delivery forms.
    --
    -- Not encrypted, and that is a considered position rather than an oversight:
    -- an address is not a credential. It is printed on the parcels arriving at
    -- the house and is already in the address book of every shop the user has
    -- ordered from. Encrypting it would need a key, and the only place to put
    -- that key is beside the data -- which buys the appearance of protection and
    -- none of the substance. Passwords, which ARE credentials, go through
    -- safeStorage instead; see PasswordVault.
    --
    -- Card numbers are deliberately absent. See docs/testing/autofill.md.
    CREATE TABLE saved_addresses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      label         TEXT    NOT NULL DEFAULT '',
      name          TEXT    NOT NULL DEFAULT '',
      given_name    TEXT    NOT NULL DEFAULT '',
      family_name   TEXT    NOT NULL DEFAULT '',
      organization  TEXT    NOT NULL DEFAULT '',
      street_line1  TEXT    NOT NULL DEFAULT '',
      street_line2  TEXT    NOT NULL DEFAULT '',
      city          TEXT    NOT NULL DEFAULT '',
      region        TEXT    NOT NULL DEFAULT '',
      postal_code   TEXT    NOT NULL DEFAULT '',
      country       TEXT    NOT NULL DEFAULT '',
      phone         TEXT    NOT NULL DEFAULT '',
      email         TEXT    NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `
}

const m023_sponsor_placement: Migration = {
  version: 23,
  name: 'sponsor_placement',
  sql: /* sql */ `
    -- Whether a cached creative is a tile or the new-tab backdrop.
    --
    -- Defaults to 'tile', so anything cached before this migration keeps
    -- rendering exactly as it did rather than silently becoming a full-screen
    -- takeover on the next launch.
    ALTER TABLE sponsored_tiles ADD COLUMN placement TEXT NOT NULL DEFAULT 'tile';
  `
}

const m024_engine_downloads: Migration = {
  version: 24,
  name: 'engine_downloads',
  sql: /* sql */ `
    -- The accelerated engine's own downloads.
    --
    -- Separate from \`downloads\`, which holds Chromium's. They are different
    -- things: a Chromium download cannot be resumed once the process exits — the
    -- request went with it — so that table is a history list. These can be
    -- resumed, which is the entire reason for writing them down, and doing that
    -- needs a segment table and the validator the server gave us.
    --
    -- Nothing here is a credential. The request context is a session partition
    -- *name*, a referrer and a user agent; cookies are asked of Chromium's own
    -- jar by partition when the download is picked up again. Private-window
    -- downloads are never written at all.
    CREATE TABLE engine_downloads (
      id               TEXT    PRIMARY KEY,
      url              TEXT    NOT NULL,
      source_host      TEXT    NOT NULL DEFAULT '',
      filename         TEXT    NOT NULL,
      save_path        TEXT    NOT NULL,
      category         TEXT    NOT NULL DEFAULT 'other',
      state            TEXT    NOT NULL,
      priority         TEXT    NOT NULL DEFAULT 'normal',
      total_bytes      INTEGER,
      received_bytes   INTEGER NOT NULL DEFAULT 0,
      connection_note  TEXT    NOT NULL DEFAULT '',
      start_after      INTEGER,
      attempts         INTEGER NOT NULL DEFAULT 0,
      error            TEXT,

      -- What the server said at the start. Without a validator a partial file
      -- cannot be continued safely, so these are not optional extras.
      accepts_ranges   INTEGER NOT NULL DEFAULT 0,
      suggested_name   TEXT,
      mime_type        TEXT,
      etag             TEXT,
      last_modified    TEXT,

      -- Enough to make the page's own request again. No cookies, no auth.
      partition        TEXT,
      referer          TEXT,
      origin           TEXT,
      user_agent       TEXT,

      -- Two-part downloads, playlists, and what a master playlist declared.
      join_audio_url   TEXT,
      is_stream        INTEGER NOT NULL DEFAULT 0 CHECK (is_stream IN (0, 1)),
      stream_bandwidth INTEGER,
      stream_quality   TEXT,

      started_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      completed_at     INTEGER
    );
    CREATE INDEX idx_engine_downloads_started ON engine_downloads (started_at DESC);

    -- One row per byte range. The download is resumable only if these add up to
    -- the file, which is checked on load rather than assumed.
    CREATE TABLE engine_download_segments (
      download_id    TEXT    NOT NULL REFERENCES engine_downloads (id) ON DELETE CASCADE,
      idx            INTEGER NOT NULL,
      start_byte     INTEGER NOT NULL,
      end_byte       INTEGER NOT NULL,
      received_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (download_id, idx)
    );
  `
}

const m025_download_queues: Migration = {
  version: 25,
  name: 'download_queues',
  sql: /* sql */ `
    -- Which named queue a download belongs to.
    --
    -- A column with a default rather than a table, because a queue is a label:
    -- the queues themselves are a handful of preferences and live in settings,
    -- and nothing here references them by key. A queue the user deletes leaves
    -- its downloads pointing at a name that no longer exists, which
    -- \`selectStartable\` handles by falling back to the first queue - so this
    -- deliberately has no foreign key to break.
    ALTER TABLE engine_downloads ADD COLUMN queue TEXT NOT NULL DEFAULT 'main';
  `
}

const m026_rewards: Migration = {
  version: 26,
  name: 'rewards',
  sql: /* sql */ `
    -- Qualifying browsing time waiting to be reported.
    --
    -- A local outbox, not a balance. The server is the authority on what has
    -- been earned; this table holds only closed intervals that have not yet
    -- been accepted, so a browser that is offline for a week does not lose the
    -- week. Rows are deleted once the server has taken them.
    --
    -- \`reported_at\` is set only after the server *accepted* the batch, never
    -- when it was merely sent. A row marked reported on send would be lost
    -- whenever a response went missing, which is the one failure mode a user
    -- would notice and could never explain.
    CREATE TABLE coin_intervals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER NOT NULL,
      seconds      INTEGER NOT NULL,
      reported_at  INTEGER,
      -- Which account the time was earned under. Signing into a different
      -- account must not hand it somebody else's unreported hours.
      account      TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX idx_coin_intervals_pending
      ON coin_intervals (reported_at, started_at);
  `
}

const m027_protection: Migration = {
  version: 27,
  name: 'protection',
  sql: /* sql */ `
    -- One row per day, holding what the browser actually did.
    --
    -- A weekly report needs a week of numbers, and the shield's counters live
    -- in memory and reset every launch, so without this the honest answer to
    -- "what did Slash save you this week" is "this session, and only if you
    -- have not restarted". Nothing here is derived or projected: every column
    -- is a count of events that happened, incremented where they happened.
    --
    -- Deliberately **not** a log. There is no host, no URL and no tab id — a
    -- table recording which sites blocked what would be a second history of
    -- everywhere somebody has been, which is exactly the thing the blocker
    -- exists to prevent. Counts only, by day.
    --
    -- Permissions are not here either: \`permission_events\` already records
    -- them with timestamps, so the report queries that rather than keeping a
    -- second tally that could disagree with it.
    CREATE TABLE protection_days (
      -- Local calendar day, 'YYYY-MM-DD'. Local rather than UTC because the
      -- report says "this week" to a person, and their week is the one their
      -- clock is on.
      day                 TEXT PRIMARY KEY,

      -- Requests the shield cancelled, split the way the shield splits them.
      ads                 INTEGER NOT NULL DEFAULT 0,
      trackers            INTEGER NOT NULL DEFAULT 0,
      popups              INTEGER NOT NULL DEFAULT 0,
      redirects           INTEGER NOT NULL DEFAULT 0,

      -- Tabs put to sleep, and the working set genuinely released. Measured at
      -- the moment each renderer was destroyed, which is the only figure in
      -- this browser that is a measurement rather than a projection.
      tabs_hibernated     INTEGER NOT NULL DEFAULT 0,
      bytes_freed         INTEGER NOT NULL DEFAULT 0,

      -- Tidying the user asked for.
      duplicates_closed   INTEGER NOT NULL DEFAULT 0,

      -- Downloads that arrived with an extension Windows will execute, and were
      -- shown a warning before they could be opened.
      downloads_flagged   INTEGER NOT NULL DEFAULT 0,

      -- Restore points and sessions brought back, and how many tabs came with
      -- them.
      sessions_restored   INTEGER NOT NULL DEFAULT 0,
      tabs_restored       INTEGER NOT NULL DEFAULT 0
    );
  `
}

const m028_workspace_archive: Migration = {
  version: 28,
  name: 'workspace_archive',
  sql: /* sql */ `
    -- Archiving a workspace: keep the work, close the tabs.
    --
    -- A research project ends and its twenty tabs are still open, holding
    -- renderers, cluttering the strip and impossible to close without losing
    -- where you got to. Archiving writes those tabs into a restore point — the
    -- snapshot system that already exists, rather than a second store — closes
    -- them, and keeps the workspace with its name and notes intact.
    --
    -- \`archived_at\` is when, and \`archive_snapshot\` is which restore point
    -- holds the tabs. Both null for an ordinary workspace, which is every
    -- workspace that exists before this migration runs.
    ALTER TABLE workspaces ADD COLUMN archived_at INTEGER;
    ALTER TABLE workspaces ADD COLUMN archive_snapshot INTEGER;
  `
}

export const migrations: readonly Migration[] = [
  m001_init,
  m002_browsing,
  m003_workspaces,
  m004_permissions,
  m005_snapshots,
  m006_memory,
  m007_ai,
  m008_icon_names,
  m009_closed_tabs,
  m010_semantic,
  m011_ai_providers,
  m012_crashes,
  m013_watched_pages,
  m014_missions,
  m015_tab_groups,
  m016_reading_list,
  m017_logins,
  m018_sponsored,
  m019_sponsor_schedule,
  m020_snapshot_windows,
  m021_sync,
  m022_addresses,
  m023_sponsor_placement,
  m024_engine_downloads,
  m025_download_queues,
  m026_rewards,
  m027_protection,
  m028_workspace_archive
]

export const LATEST_SCHEMA_VERSION: number = migrations.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0
)
