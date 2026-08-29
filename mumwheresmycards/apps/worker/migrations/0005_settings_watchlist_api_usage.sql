-- Configurable settings (filter defaults, scoring weights, fee schedules),
-- the seed grading watchlist (data only — see packages/core, no business
-- logic hardcodes these cards), and API call accounting for cost control.

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,             -- json
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Grading watchlist: a curated list of cards worth monitoring for grading
-- arbitrage. Populated via the seed import script (scripts/import-watchlist.ts),
-- never hardcoded into the opportunity/scoring engine. card_id is nullable
-- because a watchlist entry may be added before its exact printing has been
-- resolved/created in `cards`.
CREATE TABLE watchlist_cards (
  id            TEXT PRIMARY KEY,        -- uuid
  card_id       TEXT REFERENCES cards(id),
  label         TEXT NOT NULL,            -- free-text description until resolved, e.g. "Base Set Charizard 1st Ed Holo"
  strategy      TEXT NOT NULL DEFAULT 'GRADE', -- 'FLIP' | 'GRADE' | 'BOTH'
  source        TEXT,                     -- where the research came from
  priority      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_watchlist_active ON watchlist_cards(active);

CREATE TABLE api_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,           -- 'poketrace' | 'ebay-browse' | ...
  endpoint      TEXT NOT NULL,
  scan_run_id   TEXT REFERENCES scan_runs(id),
  cache_hit     INTEGER NOT NULL DEFAULT 0, -- 0/1
  cost_weight   REAL NOT NULL DEFAULT 1,     -- provider-defined unit cost (calls, or $ once known)
  called_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_usage_provider ON api_usage(provider, called_at DESC);
CREATE INDEX idx_api_usage_scan_run ON api_usage(scan_run_id);

-- Default settings seed (safe, overridable defaults matching the product spec)
INSERT INTO settings (key, value, description) VALUES
  ('flip_score_weights', '{"returnOnCapital":0.30,"netProfit":0.25,"liquidity":0.20,"confidence":0.15,"listingQuality":0.10}', 'FLIP SCORE weighting'),
  ('grade_score_weights', '{"downsideProtection":0.25,"psa9Economics":0.20,"psa10Upside":0.20,"acquisitionEconomics":0.15,"slabLiquidity":0.10,"dataConfidence":0.10}', 'GRADE SCORE weighting'),
  ('global_filters', '{"strategy":"BOTH","minNetProfit":50,"minReturnOnCapital":0.35,"minProfitMargin":0.15,"maxAcquisitionPrice":500,"minLiquidity":"MEDIUM","minConfidence":0.6}', 'Default dashboard filter values'),
  ('flip_filters', '{"minQsv":20,"maxDaysToSale":30}', 'FLIP-specific default filters'),
  ('grade_filters', '{"minPsa10Value":80,"minPsa10UpsideMultiple":2.0,"minAcceptableBreakEvenGrade":"PSA 8","safeZoneOnly":false,"maxGradedBasis":300}', 'GRADE-specific default filters'),
  ('fee_schedule', '{"ebayFinalValueFeePct":0.1325,"ebayFixedFeePerOrder":0.30,"paymentProcessingPct":0.0,"gradingFeePsaRegular":25,"gradingUpchargeReserve":15,"insuredPostageAllocation":8,"outboundPostageDefault":4.5,"packagingDefault":1.5,"cardSaverCost":0.2,"sleeveCost":0.1,"gradingReturnShippingDefault":7,"gradingInsuranceDefault":3,"gradingUpchargeThreshold":500}', 'Default fee/cost schedule (GBP), editable in Settings UI');
