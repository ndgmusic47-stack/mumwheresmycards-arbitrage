-- Market valuation data (transaction/sold-data derived — NOT active asking
-- prices) and live eBay supply-side listings. Kept in separate tables
-- because they represent fundamentally different signals (see ARCHITECTURE.md
-- section 4: "Market valuation policy").

CREATE TABLE market_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id             TEXT NOT NULL REFERENCES cards(id),
  source_provider     TEXT NOT NULL,              -- 'poketrace' | 'pricecharting' | ...
  captured_at         TEXT NOT NULL DEFAULT (datetime('now')),
  price_timestamp     TEXT NOT NULL,               -- timestamp of underlying sold data
  raw_market_price    REAL,                        -- ungraded market value
  raw_qsv             REAL,                        -- ungraded quick-sale value
  psa7                REAL,
  psa8                REAL,
  psa9                REAL,
  psa10               REAL,
  confidence          REAL NOT NULL DEFAULT 0,     -- 0..1
  liquidity           TEXT NOT NULL DEFAULT 'LOW',  -- 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH'
  sample_size         INTEGER,                     -- number of sold comps behind this snapshot
  psa_population_7    INTEGER,
  psa_population_8    INTEGER,
  psa_population_9    INTEGER,
  psa_population_10   INTEGER,
  historical_gem_rate REAL,                        -- informational only — NOT a probability estimate
  outliers_excluded   INTEGER NOT NULL DEFAULT 0,   -- count of comps trimmed as outliers
  raw_payload         TEXT,                        -- json, provider's raw response for audit
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_market_snapshots_card ON market_snapshots(card_id, captured_at DESC);
CREATE INDEX idx_market_snapshots_provider ON market_snapshots(source_provider);

CREATE TABLE ebay_listings (
  id                    TEXT PRIMARY KEY,          -- eBay item id
  card_id               TEXT REFERENCES cards(id),  -- NULL until identity resolved
  identity_confidence   REAL NOT NULL DEFAULT 0,    -- resolver's confidence in card_id match (0..1)
  identity_notes        TEXT,                       -- why ambiguous / how resolved
  title                 TEXT NOT NULL,
  price                 REAL NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'GBP',
  shipping_cost         REAL NOT NULL DEFAULT 0,
  listing_type          TEXT NOT NULL DEFAULT 'FIXED', -- 'FIXED' | 'AUCTION' | 'BEST_OFFER'
  item_condition        TEXT,
  seller_username       TEXT,
  seller_feedback_score INTEGER,
  seller_feedback_pct   REAL,
  item_url              TEXT NOT NULL,
  image_urls            TEXT,                       -- json array
  location_country      TEXT,
  watchers              INTEGER,
  bids                  INTEGER,
  end_time              TEXT,
  fetched_at            TEXT NOT NULL DEFAULT (datetime('now')),
  status                TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE' | 'ENDED' | 'SOLD' | 'REMOVED'
  raw_payload           TEXT,                       -- json, provider's raw response for audit
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ebay_listings_card ON ebay_listings(card_id);
CREATE INDEX idx_ebay_listings_status ON ebay_listings(status, fetched_at DESC);
