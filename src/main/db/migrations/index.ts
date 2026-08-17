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
  m013_watched_pages
]

export const LATEST_SCHEMA_VERSION: number = migrations.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0
)
