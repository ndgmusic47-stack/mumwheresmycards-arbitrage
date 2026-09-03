-- AI INTELLIGENCE gap 4 (financial engineering): "make one authoritative
-- versioned financial settings path actually drive the engine."
--
-- Before this migration, this codebase had TWO settings-shaped things:
--   1. `settings` (migration 0005) — key/value blobs (selling_costs,
--      grading_batch, grading_consumables, exit_market_fees, fx_rates, ...)
--      that loadSettings() (apps/worker/src/repo/settingsRepo.ts) reads on
--      every request and scanRunner.ts's engine actually computes against.
--      This DOES drive the engine, but had no version/history at all — a
--      PUT overwrote a row with zero trace of what it replaced.
--   2. `financial_assumptions`/`financial_assumptions_history` (migration
--      0017) — genuinely versioned and historized, but explicitly
--      DESCRIPTIVE (see that migration's own doc comment): writing there
--      never changed engine behaviour, and its fine-grained per-field ids
--      (e.g. "sellingCosts.outboundPostageRaw") don't even name-match the
--      real SellingCostSettings fields (outboundPostage, not
--      outboundPostageRaw) — a real, acknowledged drift risk, not a typo.
--
-- Rather than migrate the engine onto the fine-grained, drift-prone ledger
-- (a much larger, riskier change for the same fields' worth of coverage),
-- this migration makes the settings table that ALREADY drives the engine
-- ALSO versioned and historized — collapsing to the one authoritative path
-- the spec asks for, with the smallest possible blast radius. `settings.
-- version` increments on every write; `settings_history` is append-only,
-- capturing exactly the value+version a row held immediately before being
-- superseded — see updateSetting()'s doc comment in settingsRepo.ts for how
-- a write archives-then-updates atomically from the caller's point of view.
--
-- Deliberately covers EVERY settings key uniformly (not just packaging/
-- postage/grading/fees) since they all already go through the same single
-- updateSetting() write path — special-casing only "financial" keys would
-- mean maintaining two different write behaviours for what is mechanically
-- the same table and the same function. financial_assumptions is left
-- exactly as it was (still real, still useful for its original broader
-- audit purpose — fee percentages, QSV modelling constants, FX rates, and
-- the item-12 "known unknowns" like import tax) — this migration does not
-- remove or supersede it, just stops it being the ONLY versioned thing.
ALTER TABLE settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT
);

CREATE INDEX idx_settings_history_key ON settings_history(key, version);
