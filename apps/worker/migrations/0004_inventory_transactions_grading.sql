-- Realised economics. Populated only once the user actually acts on an
-- opportunity. Forecast numbers live on `opportunities` and are never
-- overwritten; these tables hold ACTUAL costs/outcomes for comparison.

CREATE TABLE inventory (
  id                          TEXT PRIMARY KEY,        -- uuid
  opportunity_id              TEXT REFERENCES opportunities(id),
  card_id                     TEXT NOT NULL REFERENCES cards(id),
  strategy                    TEXT NOT NULL,            -- 'FLIP' | 'GRADE'
  status                      TEXT NOT NULL DEFAULT 'PURCHASED',
                                -- 'PURCHASED' | 'AWAITING_GRADING' | 'GRADED' | 'LISTED' | 'SOLD' | 'ARCHIVED'
  actual_purchase_price       REAL NOT NULL,
  actual_seller_postage       REAL NOT NULL DEFAULT 0,
  actual_import_tax           REAL NOT NULL DEFAULT 0,
  actual_other_acquisition_fees REAL NOT NULL DEFAULT 0,
  actual_total_acquisition_cost REAL NOT NULL,
  source_url                  TEXT,
  purchased_at                TEXT NOT NULL DEFAULT (datetime('now')),
  notes                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_inventory_status ON inventory(status);
CREATE INDEX idx_inventory_card ON inventory(card_id);

CREATE TABLE grading_submissions (
  id                     TEXT PRIMARY KEY,             -- uuid
  inventory_id           TEXT NOT NULL REFERENCES inventory(id),
  service                TEXT NOT NULL DEFAULT 'PSA',
  submission_level       TEXT,                          -- e.g. 'Value', 'Regular', 'Express'
  submitted_at           TEXT NOT NULL DEFAULT (datetime('now')),
  tracking_number        TEXT,
  actual_grading_fee     REAL NOT NULL DEFAULT 0,
  actual_postage_out     REAL NOT NULL DEFAULT 0,
  actual_insurance       REAL NOT NULL DEFAULT 0,
  actual_packaging       REAL NOT NULL DEFAULT 0,
  expected_return_date   TEXT,
  status                 TEXT NOT NULL DEFAULT 'SUBMITTED', -- 'SUBMITTED' | 'IN_PROGRESS' | 'RETURNED'
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_grading_submissions_inventory ON grading_submissions(inventory_id);

CREATE TABLE grading_results (
  id                      TEXT PRIMARY KEY,            -- uuid
  submission_id           TEXT NOT NULL REFERENCES grading_submissions(id),
  grade_label             TEXT NOT NULL,                -- 'PSA 9'
  grade_numeric           REAL NOT NULL,                 -- 9
  cert_number             TEXT,
  returned_at             TEXT NOT NULL DEFAULT (datetime('now')),
  actual_return_postage   REAL NOT NULL DEFAULT 0,
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_grading_results_submission ON grading_results(submission_id);

CREATE TABLE transactions (
  id                        TEXT PRIMARY KEY,           -- uuid
  inventory_id              TEXT NOT NULL REFERENCES inventory(id),
  sale_price                REAL NOT NULL,
  sale_platform             TEXT NOT NULL DEFAULT 'EBAY',
  marketplace_fees          REAL NOT NULL DEFAULT 0,
  payment_processing_fees   REAL NOT NULL DEFAULT 0,
  outbound_postage          REAL NOT NULL DEFAULT 0,
  insurance                 REAL NOT NULL DEFAULT 0,
  packaging                 REAL NOT NULL DEFAULT 0,
  real_cash_proceeds        REAL NOT NULL,
  real_net_profit           REAL NOT NULL,
  real_return_on_capital    REAL NOT NULL,
  days_held                 INTEGER NOT NULL,
  sold_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  buyer_notes               TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transactions_inventory ON transactions(inventory_id);
CREATE INDEX idx_transactions_sold_at ON transactions(sold_at DESC);
