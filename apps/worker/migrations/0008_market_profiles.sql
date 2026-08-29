-- CARD MARKET layer (see ARCHITECTURE.md "three layers": CARD MARKET / LIVE
-- SUPPLY / OPPORTUNITY): the automatically-computed Dynamic Flip Universe
-- and Dynamic Grade Universe. Independent of any specific eBay listing —
-- these describe "is this card economically interesting at all", computed
-- from market data alone across the WHOLE catalogue, refreshed
-- periodically. One row per card per strategy; a card can be
-- flip-eligible, grade-eligible, both, or neither.
CREATE TABLE flip_profiles (
  card_id                             TEXT PRIMARY KEY REFERENCES cards(id),
  market_snapshot_id                  INTEGER REFERENCES market_snapshots(id),
  raw_market_value                    REAL,
  conservative_qsv                    REAL,
  raw_sample_size                     INTEGER,       -- sold-comp count behind raw_market_value, for the MARKET tab's "raw sales" filter
  liquidity                           TEXT NOT NULL DEFAULT 'LOW',
  confidence                          REAL NOT NULL DEFAULT 0,
  max_profitable_acquisition_price    REAL,          -- highest acquisition price that would still clear the global profit/ROC filters
  eligible                            INTEGER NOT NULL DEFAULT 0,
  flip_market_score                   REAL,
  ineligible_reason                   TEXT,
  computed_at                         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_flip_profiles_eligible ON flip_profiles(eligible, flip_market_score DESC);

CREATE TABLE grade_profiles (
  card_id                 TEXT PRIMARY KEY REFERENCES cards(id),
  market_snapshot_id      INTEGER REFERENCES market_snapshots(id),
  raw_market_value        REAL,
  psa7                    REAL,
  psa8                    REAL,
  psa9                    REAL,
  psa10                   REAL,
  raw_sample_size         INTEGER,       -- sold-comp count behind raw_market_value, for the MARKET tab's "raw sales" filter
  reference_graded_basis  REAL,        -- basis computed against raw_market_value as a REFERENCE acquisition price, NOT an actual purchase — see ARCHITECTURE.md
  reference_psa7_profit   REAL,
  reference_psa8_profit   REAL,
  reference_psa9_profit   REAL,
  reference_psa10_profit  REAL,
  break_even_grade        INTEGER,
  psa10_upside_multiple   REAL,
  liquidity               TEXT NOT NULL DEFAULT 'LOW',
  confidence              REAL NOT NULL DEFAULT 0,
  eligible                INTEGER NOT NULL DEFAULT 0,
  grade_market_score      REAL,
  ineligible_reason       TEXT,
  computed_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_grade_profiles_eligible ON grade_profiles(eligible, grade_market_score DESC);

-- Used by the eBay-search prioritisation step (packages/core/src/market/prioritization.ts)
-- to avoid starving cards that haven't been checked in a while.
ALTER TABLE cards ADD COLUMN last_ebay_scanned_at TEXT;
