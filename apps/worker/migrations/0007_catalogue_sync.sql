-- Resumable catalogue sync: automatically enumerates a market-data
-- provider's full Pokémon singles catalogue into `cards` +
-- `external_card_refs`, so the application bootstraps itself from an empty
-- database instead of relying on any manually-seeded card list. Two
-- tables: a persistent per-provider checkpoint (so a scan/cron tick can
-- resume exactly where the last one left off, including after a mid-sync
-- failure), and a run-history log for observability (pages fetched, cards
-- inserted/updated, API calls, errors per run).
CREATE TABLE catalogue_sync_checkpoint (
  provider                      TEXT PRIMARY KEY,
  cursor                        TEXT,               -- provider's opaque pagination cursor; NULL = start from the beginning
  last_full_sync_completed_at   TEXT,                -- set only when a sync run's pagination reaches hasMore=false
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE catalogue_sync_runs (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'RUNNING', -- 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED'
  cursor_start    TEXT,
  cursor_end      TEXT,
  pages_fetched   INTEGER NOT NULL DEFAULT 0,
  cards_inserted  INTEGER NOT NULL DEFAULT 0,
  cards_updated   INTEGER NOT NULL DEFAULT 0,
  cards_skipped   INTEGER NOT NULL DEFAULT 0,        -- e.g. unmappable provider variant, unresolved set year
  api_calls_made  INTEGER NOT NULL DEFAULT 0,
  reached_end     INTEGER NOT NULL DEFAULT 0,        -- 1 if this run's pagination reached hasMore=false
  errors          TEXT,                               -- json array
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT
);

CREATE INDEX idx_catalogue_sync_runs_provider ON catalogue_sync_runs(provider, started_at DESC);
