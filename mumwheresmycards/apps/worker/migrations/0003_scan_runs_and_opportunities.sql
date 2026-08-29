-- scan_runs bookkeeps each scheduled/manual scan; opportunities are the
-- FORECAST-only output of the opportunity engine for a given listing +
-- market snapshot pairing at scan time. Forecast fields are never mutated
-- after creation by realised (inventory/transaction) data — see
-- ARCHITECTURE.md section 7.

CREATE TABLE scan_runs (
  id                      TEXT PRIMARY KEY,          -- uuid
  trigger                 TEXT NOT NULL DEFAULT 'CRON', -- 'CRON' | 'MANUAL'
  started_at              TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at             TEXT,
  status                  TEXT NOT NULL DEFAULT 'RUNNING', -- 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PARTIAL'
  strategy_scope          TEXT NOT NULL DEFAULT '["FLIP","GRADE"]', -- json array
  listings_fetched        INTEGER NOT NULL DEFAULT 0,
  market_snapshots_fetched INTEGER NOT NULL DEFAULT 0,
  opportunities_created   INTEGER NOT NULL DEFAULT 0,
  opportunities_updated   INTEGER NOT NULL DEFAULT 0,
  api_calls_made          INTEGER NOT NULL DEFAULT 0,
  errors                  TEXT,                       -- json array of error messages, if any
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scan_runs_started ON scan_runs(started_at DESC);

CREATE TABLE opportunities (
  id                          TEXT PRIMARY KEY,       -- uuid
  card_id                     TEXT NOT NULL REFERENCES cards(id),
  listing_id                  TEXT NOT NULL REFERENCES ebay_listings(id),
  market_snapshot_id          INTEGER REFERENCES market_snapshots(id),
  scan_run_id                 TEXT REFERENCES scan_runs(id),
  strategy                    TEXT NOT NULL,          -- 'FLIP' | 'GRADE'
  state                       TEXT NOT NULL,           -- see packages/core/src/opportunity/states.ts
  flip_score                  REAL,
  grade_score                 REAL,

  -- shared forecast economics
  listing_price               REAL NOT NULL,
  total_acquisition_cost      REAL NOT NULL,
  liquidity                   TEXT NOT NULL,
  confidence                  REAL NOT NULL,

  -- FLIP forecast
  qsv                         REAL,
  expected_net_sale_proceeds  REAL,
  expected_net_profit         REAL,
  return_on_capital           REAL,
  profit_margin               REAL,
  days_to_sale_estimate       REAL,

  -- GRADE forecast
  total_graded_basis          REAL,
  psa6_profit                 REAL,
  psa7_profit                 REAL,
  psa8_profit                 REAL,
  psa9_profit                 REAL,
  psa10_profit                REAL,
  break_even_grade            TEXT,
  psa10_upside_multiple       REAL,

  reasoning                   TEXT,                    -- json: confidence reasoning, checklist, rejection cause
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_opportunities_state ON opportunities(state, created_at DESC);
CREATE INDEX idx_opportunities_strategy ON opportunities(strategy, flip_score DESC);
CREATE INDEX idx_opportunities_card ON opportunities(card_id);
CREATE INDEX idx_opportunities_listing ON opportunities(listing_id);
CREATE UNIQUE INDEX idx_opportunities_listing_strategy ON opportunities(listing_id, strategy);
