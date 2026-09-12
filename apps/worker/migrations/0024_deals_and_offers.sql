-- PER-CARD TRADING DESK: saved deal assumptions, offer lifecycle, real
-- grading batches, and a frozen decision record at purchase.
--
-- WHY NEW TABLES RATHER THAN COLUMNS ON `opportunities`. An opportunity row
-- is the ENGINE's forecast for a listing, rewritten on every rescan by
-- `upsertOpportunity`. The operator's own assumptions must survive exactly
-- that rewrite (the same reasoning that keeps review_status out of the
-- ON CONFLICT clause in migration 0016 — see its note). Keeping them in
-- their own table makes that structural rather than something a future edit
-- to the UPSERT could undo by adding a column "for consistency".
--
-- WHY `inputs_json` RATHER THAN A COLUMN PER FIELD. Each input carries an
-- amount, a currency, a provenance and a note — four values per field across
-- ~15 fields. As columns that is 60 columns and a migration every time a
-- field is added. The codebase already stores structured value objects as
-- JSON where the shape is owned by a typed module (grade_rungs,
-- forecast_snapshot, settings.value). `packages/core/src/deal/` owns this
-- shape and validates it on the way in.

CREATE TABLE deals (
  id                  TEXT PRIMARY KEY,
  -- One deal per opportunity. UNIQUE is what makes "save my assumptions"
  -- idempotent: saving twice updates, never duplicates.
  opportunity_id      TEXT NOT NULL UNIQUE REFERENCES opportunities(id),
  card_id             TEXT NOT NULL REFERENCES cards(id),
  strategy            TEXT NOT NULL,                      -- 'FLIP' | 'GRADE'
  grader_id           TEXT,                               -- null for FLIP
  grading_service_name TEXT,
  -- The full DealInputs object (see packages/core/src/deal/dealCalculator.ts).
  inputs_json         TEXT NOT NULL,
  -- The FX rates this deal is priced against, frozen at save time so a
  -- reopened deal reproduces the same pennies.
  fx_snapshot_json    TEXT NOT NULL,
  -- Which calculator produced the figures, so a future change to the
  -- arithmetic is detectable rather than silently reinterpreting old deals.
  calc_version        TEXT NOT NULL,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deals_card ON deals(card_id);

-- OFFERS. Append-only history: an offer is never edited in place and never
-- deleted. Revising an offer writes a NEW row pointing at the one it
-- replaces, so "what did I actually offer, and when" stays answerable.
--
-- A PENDING offer is NOT money spent. It is an exposure — what would be
-- committed if the seller said yes. The two must never be added together,
-- which is why status lives here and actual spend lives on `inventory`.
CREATE TABLE deal_offers (
  id            TEXT PRIMARY KEY,
  deal_id       TEXT NOT NULL REFERENCES deals(id),
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'GBP',
  -- The rate used to express this offer in GBP for exposure totals, frozen
  -- at placement. Null only for a GBP offer.
  rate_to_gbp   REAL,
  amount_gbp    REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','ACCEPTED','REJECTED','EXPIRED','WITHDRAWN')),
  placed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT,
  expires_at    TEXT,
  -- The offer this one revises, if any. Null for a first offer.
  supersedes_id TEXT REFERENCES deal_offers(id),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deal_offers_deal ON deal_offers(deal_id);
CREATE INDEX idx_deal_offers_status ON deal_offers(status);

-- REAL GRADING BATCHES. `settings.gradingBatch.batchSize` is a PLANNING
-- figure used by the scan engine to estimate a per-card share. This table is
-- the actual thing: a submission with actual members and actual shipping
-- costs, so an estimated allocation can be replaced by a real one once the
-- batch exists.
CREATE TABLE grading_batches (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  grader_id             TEXT NOT NULL,
  service_name          TEXT,
  status                TEXT NOT NULL DEFAULT 'PLANNED'
                          CHECK (status IN ('PLANNED','SUBMITTED','RETURNED','CANCELLED')),
  -- Batch-level costs, in GBP. Divided across members, never per card.
  submission_postage    REAL,
  return_postage        REAL,
  insurance             REAL,
  submitted_at          TEXT,
  returned_at           TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE grading_batch_members (
  batch_id    TEXT NOT NULL REFERENCES grading_batches(id),
  deal_id     TEXT REFERENCES deals(id),
  inventory_id TEXT REFERENCES inventory(id),
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (batch_id, deal_id, inventory_id)
);

CREATE INDEX idx_grading_batch_members_deal ON grading_batch_members(deal_id);
CREATE INDEX idx_grading_batch_members_inventory ON grading_batch_members(inventory_id);

-- THE FROZEN DECISION. `inventory.forecast_snapshot` (migration 0013) already
-- freezes the ENGINE's forecast at purchase. That is not the same thing as
-- the decision the operator actually made, which is based on their own saved
-- overrides. This column freezes THAT — the deal inputs, the FX snapshot and
-- the calculation, exactly as they stood when the purchase was committed.
-- Later market updates and later forecasts never rewrite it.
ALTER TABLE inventory ADD COLUMN deal_id TEXT REFERENCES deals(id);
ALTER TABLE inventory ADD COLUMN decision_snapshot TEXT;

-- Prevents the same deal being purchased twice. A partial index so the many
-- inventory rows with no deal_id (bought before this feature, or recorded
-- directly) do not collide with each other on NULL.
CREATE UNIQUE INDEX idx_inventory_one_purchase_per_deal ON inventory(deal_id) WHERE deal_id IS NOT NULL;
