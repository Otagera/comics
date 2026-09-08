/**
 * Schema migrations, in order.
 *
 * Inlined as a module rather than read from .sql files at runtime: the server
 * is bundled by Nitro, so a path resolved from import.meta.url does not
 * survive into the built output.
 *
 * Migrations are append-only. Never edit an applied one -- add the next.
 */

export interface Migration {
  name: string
  sql: string
}

export const migrations: Migration[] = [
  {
    name: '001_init',
    sql: `
-- Comics sidecar: Drive-backed catalogue + reading tracker + wishlist.
--
-- ID-first by design. \`comic.id\` is minted once, the first time a file is seen
-- in Drive, and never changes. Everything else -- the Komga book, the future
-- Notion page, reading status, cache state -- hangs off that id. \`komga_id\` and
-- \`notion_page_id\` are nullable from day one so the v2 Notion sync is a column
-- fill, not a migration.

CREATE TABLE comic (
  id                TEXT PRIMARY KEY,

  -- Drive identity. \`drive_id\` is rclone's Drive file ID: it survives renames
  -- and moves, so it -- not the path -- is what re-identifies a file across
  -- index refreshes.
  drive_id          TEXT UNIQUE,
  drive_path        TEXT NOT NULL UNIQUE,
  drive_bucket      TEXT,               -- top-level folder: DC, Marvel, Others, ...
  file_name         TEXT NOT NULL,
  ext               TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  drive_modified_at TEXT,

  -- Parsed from the scene-release filename. Display fields today; the matching
  -- key for Notion tomorrow.
  parsed_series     TEXT,
  parsed_title      TEXT,               -- subtitle / arc, e.g. "The Zoo"
  parsed_issue      TEXT,
  parsed_volume     INTEGER,
  parsed_year       INTEGER,
  parsed_publisher  TEXT,
  parsed_kind       TEXT,               -- issue|volume|collection|oneshot|unknown
  parsed_confidence REAL NOT NULL DEFAULT 0,
  sort_key          TEXT,               -- normalised series for grouping/matching

  -- External system ids. Recorded, never guessed.
  komga_id          TEXT,               -- book id; set at fetch time
  komga_series_id   TEXT,
  notion_page_id    TEXT,               -- stays NULL until v2

  -- Local cache state. The volume is a cache over Drive; Drive holds masters.
  local_state       TEXT NOT NULL DEFAULT 'remote'
                      CHECK (local_state IN ('remote','fetching','local','error')),
  local_path        TEXT,
  fetched_at        TEXT,
  evicted_at        TEXT,
  evict_count       INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),

  -- Presence tracking across index refreshes.
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  missing_from_drive INTEGER NOT NULL DEFAULT 0 CHECK (missing_from_drive IN (0,1))
);

CREATE INDEX comic_local_state   ON comic (local_state);
CREATE INDEX comic_sort_key      ON comic (sort_key);
CREATE INDEX comic_komga_id      ON comic (komga_id);
CREATE INDEX comic_notion_page   ON comic (notion_page_id);
CREATE INDEX comic_bucket        ON comic (drive_bucket);

-- The user's own intent for a title. Deliberately separate from Komga's
-- progress: "abandoned" is a decision, not a page count, and Komga has no
-- concept of it.
CREATE TABLE reading_status (
  comic_id  TEXT PRIMARY KEY REFERENCES comic(id) ON DELETE CASCADE,
  status    TEXT NOT NULL
              CHECK (status IN ('want','reading','finished','abandoned')),
  set_at    TEXT NOT NULL,
  note      TEXT
);

CREATE INDEX reading_status_status ON reading_status (status);

-- Mirror of Komga's read progress, pulled on a schedule. Cached so the
-- catalogue and the eviction scorer never depend on Komga being reachable.
-- Komga exposes readDate/lastModified, so unlike ComiXed we get real
-- last-read timestamps rather than inferring from file atime.
CREATE TABLE komga_progress (
  comic_id      TEXT PRIMARY KEY REFERENCES comic(id) ON DELETE CASCADE,
  komga_book_id TEXT NOT NULL,
  page          INTEGER,
  pages_count   INTEGER,
  completed     INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  read_date     TEXT,
  last_modified TEXT,
  synced_at     TEXT NOT NULL
);

CREATE INDEX komga_progress_read_date ON komga_progress (read_date);

-- Things the user wants that are not in Drive yet. On each index refresh a
-- wishlist row whose norm_key matches a newly-seen comic flips to 'available'.
CREATE TABLE wishlist (
  id               TEXT PRIMARY KEY,
  query            TEXT NOT NULL,
  norm_key         TEXT NOT NULL,
  series           TEXT,
  issue            TEXT,
  year             INTEGER,
  publisher        TEXT,
  status           TEXT NOT NULL DEFAULT 'wanted'
                     CHECK (status IN ('wanted','available','fulfilled','dropped')),
  matched_comic_id TEXT REFERENCES comic(id) ON DELETE SET NULL,
  notion_page_id   TEXT,
  created_at       TEXT NOT NULL,
  matched_at       TEXT
);

CREATE INDEX wishlist_norm_key ON wishlist (norm_key);
CREATE INDEX wishlist_status   ON wishlist (status);

-- One row per index refresh, so the UI can show when the catalogue was last
-- reconciled with Drive and whether it worked.
CREATE TABLE index_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT NOT NULL,          -- cron|manual|startup
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  files_seen  INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  missing     INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

-- Fetch/evict/scan audit trail.
CREATE TABLE job (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('fetch','evict','scan','progress_sync')),
  comic_id    TEXT REFERENCES comic(id) ON DELETE SET NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  detail      TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX job_kind_started ON job (kind, started_at DESC);
CREATE INDEX job_comic        ON job (comic_id);

CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
]
