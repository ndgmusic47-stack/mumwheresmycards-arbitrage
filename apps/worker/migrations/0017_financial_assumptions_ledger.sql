-- AI INTELLIGENCE spec item 11 (financial-assumptions ledger) and item 12
-- (unknown-money-inputs audit).
--
-- Every number that feeds a profit/ROC/margin calculation already lives
-- SOMEWHERE in this codebase (calc/fees.ts, market/qsv.ts, calc/types.ts,
-- market/currency.ts, opportunity/engine.ts's DEFAULTS) — but scattered
-- across module-level constants with no single place that says how much
-- each one should be TRUSTED, or when it last changed. This migration adds
-- that place: a versioned ledger, seeded with the actual values already
-- live in the code as of this migration (not placeholders), each honestly
-- classified:
--
--   VERIFIED       — checked against an external, authoritative source
--                     (e.g. eBay's own published UK business seller fee
--                     schedule) at the time noted in source_note. NOT a
--                     claim that it is still current today — re-verify
--                     periodically, fees change.
--   USER_SUPPLIED  — a business-specific number only the operator actually
--                     knows (their real postage costs, their VAT
--                     position, their grading service's real batch
--                     shipping cost) — seeded with a reasonable starting
--                     estimate, but the whole point is this should be
--                     overwritten with the operator's real number.
--   DERIVED        — a modelling judgment call this project made (a
--                     haircut percentage, a confidence multiplier, a
--                     days-to-sale estimate), not measured from this
--                     operator's own realised sales yet. Once the
--                     realised-vs-predicted reconciliation system (a
--                     later AI INTELLIGENCE item) has enough real sales,
--                     these should be recalibrated from real data, not
--                     left as launch-day guesses forever.
--   UNKNOWN        — present in the schema/model but not actually backed
--                     by any real number today (see the item 12 audit
--                     note in each such row's source_note).
--
-- financial_assumptions holds CURRENT state; financial_assumptions_history
-- is append-only and captures every value a row held before being
-- superseded — see financialAssumptionsRepo.ts for how a write updates
-- both atomically. This ledger is deliberately DESCRIPTIVE, not a second
-- source of truth the engine reads at runtime — the engine still reads its
-- real inputs from `settings` and the calc/* module constants exactly as
-- before; this ledger's job is auditability of those same numbers, not to
-- replace them (changing a value here does NOT change engine behaviour).

CREATE TABLE financial_assumptions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  value_json TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('VERIFIED','USER_SUPPLIED','DERIVED','UNKNOWN')),
  source_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE financial_assumptions_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assumption_id TEXT NOT NULL REFERENCES financial_assumptions(id),
  version INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('VERIFIED','USER_SUPPLIED','DERIVED','UNKNOWN')),
  source_note TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT
);

CREATE INDEX idx_financial_assumptions_history_assumption ON financial_assumptions_history(assumption_id, version);

-- ---------------------------------------------------------------------------
-- Seed: the real values live in calc/fees.ts (DEFAULT_EXIT_MARKET_FEE_MODEL),
-- calc/types.ts (DEFAULT_SELLING_COSTS, DEFAULT_GRADING_BATCH,
-- DEFAULT_GRADING_CONSUMABLES), market/qsv.ts (DEFAULT_QSV_SETTINGS),
-- market/currency.ts (DEFAULT_FX_RATES), and opportunity/engine.ts's
-- DEFAULTS.rawDaysToSale / grading/serviceComparison.ts's
-- DEFAULT_SLAB_DAYS_TO_SALE, as of this migration. This is a SNAPSHOT for
-- audit visibility — if a future code change edits one of those constants
-- without also updating its ledger row, the ledger will silently drift out
-- of sync with reality. No automated drift check exists yet; that is a
-- known limit of this first pass, not a claim this can't happen.
-- ---------------------------------------------------------------------------

INSERT INTO financial_assumptions (id, category, label, value_json, classification, source_note, version, updated_at, updated_by) VALUES
  ('fee.finalValueFeePct', 'EBAY_FEES', 'eBay UK final value fee (% of buyer payment)', '0.109', 'VERIFIED', 'eBay UK business seller published fee schedule, checked when the fee model was rebuilt (see calc/fees.ts doc comment). Re-verify against ebay.co.uk''s current published rates before relying on this for a large purchase decision — fee schedules change without this ledger being notified.', 1, datetime('now'), 'migration_0017_seed'),
  ('fee.regulatoryOperatingFeePct', 'EBAY_FEES', 'eBay UK regulatory operating fee (% of buyer payment)', '0.0035', 'VERIFIED', 'Same source and caveat as fee.finalValueFeePct.', 1, datetime('now'), 'migration_0017_seed'),
  ('fee.perOrderFee', 'EBAY_FEES', 'eBay UK per-order fixed fee (GBP)', '0.4', 'VERIFIED', 'Same source and caveat as fee.finalValueFeePct.', 1, datetime('now'), 'migration_0017_seed'),
  ('fee.feeVatRate', 'EBAY_FEES', 'VAT rate charged on eBay seller fees', '0.2', 'VERIFIED', 'UK standard VAT rate at time of build. Re-verify if UK VAT policy changes.', 1, datetime('now'), 'migration_0017_seed'),
  ('fee.sellerFeeVatRecoverable', 'EBAY_FEES', 'Whether this seller can reclaim VAT on eBay fees', 'false', 'USER_SUPPLIED', 'Depends on the operator''s own VAT registration/reclaim position — defaults conservatively to false (VAT treated as a real cost) until the operator confirms otherwise in Settings.', 1, datetime('now'), 'migration_0017_seed'),
  ('qsv.quickSaleHaircutPct', 'QSV_MODEL', 'Discount applied to the sold median to get a conservative quick-sale value', '0.08', 'DERIVED', 'A modelling judgment call (sell below the recent median for a faster, more certain sale), not measured from this operator''s own realised sales. Candidate for recalibration once the realised-vs-predicted reconciliation system has real sales data.', 1, datetime('now'), 'migration_0017_seed'),
  ('qsv.singleMedianConfidenceMultiplier', 'QSV_MODEL', 'Confidence penalty when only one of the 7-day/30-day sold medians is available', '0.75', 'DERIVED', 'Same caveat as qsv.quickSaleHaircutPct.', 1, datetime('now'), 'migration_0017_seed'),
  ('qsv.fallbackConfidenceCeiling', 'QSV_MODEL', 'Maximum confidence allowed when QSV falls back to a non-median market reference', '0.35', 'DERIVED', 'Same caveat as qsv.quickSaleHaircutPct.', 1, datetime('now'), 'migration_0017_seed'),
  ('sellingCosts.outboundPostageRaw', 'FULFILMENT_COSTS', 'Assumed outbound postage cost for a raw card sale (GBP)', '1.55', 'USER_SUPPLIED', 'A starting estimate for a tracked, low-value UK postage option — should be replaced with the operator''s actual real-world postage cost in Settings.', 1, datetime('now'), 'migration_0017_seed'),
  ('sellingCosts.outboundPostageGraded', 'FULFILMENT_COSTS', 'Assumed outbound postage cost for a graded slab sale (GBP)', '4.5', 'USER_SUPPLIED', 'Same caveat as sellingCosts.outboundPostageRaw — slabs are heavier/bulkier.', 1, datetime('now'), 'migration_0017_seed'),
  ('sellingCosts.packaging', 'FULFILMENT_COSTS', 'Assumed packaging materials cost per sale (GBP)', '0.75', 'USER_SUPPLIED', 'A starting estimate — should be replaced with the operator''s actual packaging cost.', 1, datetime('now'), 'migration_0017_seed'),
  ('sellingCosts.saleInsuranceGraded', 'FULFILMENT_COSTS', 'Assumed shipping insurance cost for a graded slab sale (GBP)', '2.5', 'USER_SUPPLIED', 'A starting estimate — should be replaced with the operator''s actual insurance cost, which scales with declared value.', 1, datetime('now'), 'migration_0017_seed'),
  ('daysToSale.raw', 'CAPITAL_VELOCITY', 'Estimated days from listing to sale for a RAW card, by liquidity tier', '{"LOW":60,"MEDIUM":30,"HIGH":14,"VERY_HIGH":7}', 'DERIVED', 'A modelling estimate, not yet calibrated against this operator''s own realised sale timings — no realised-sale calibration exists in this codebase today (see also item 16''s realised-vs-predicted reconciliation, not yet built). Treat as an approximation for capital-velocity RANKING, not a guarantee of any specific sale date.', 1, datetime('now'), 'migration_0017_seed'),
  ('gradingBatch.batchSize', 'GRADING_LOGISTICS', 'Assumed number of cards submitted together per grading batch', '10', 'USER_SUPPLIED', 'Depends entirely on the operator''s actual submission habits — should be set to their real typical batch size.', 1, datetime('now'), 'migration_0017_seed'),
  ('gradingBatch.batchOutboundPostage', 'GRADING_LOGISTICS', 'Assumed outbound postage cost for a full grading batch (GBP)', '15', 'USER_SUPPLIED', 'A starting estimate — should be replaced with the operator''s actual real shipping cost to their grading service.', 1, datetime('now'), 'migration_0017_seed'),
  ('gradingBatch.batchReturnPostage', 'GRADING_LOGISTICS', 'Assumed return postage cost for a full grading batch (GBP)', '20', 'USER_SUPPLIED', 'Same caveat as gradingBatch.batchOutboundPostage.', 1, datetime('now'), 'migration_0017_seed'),
  ('gradingBatch.batchInsurance', 'GRADING_LOGISTICS', 'Assumed declared-value insurance cost for a full grading batch (GBP)', '12', 'USER_SUPPLIED', 'A starting estimate — the real cost scales with the batch''s total declared value, which this flat figure does not model.', 1, datetime('now'), 'migration_0017_seed'),
  ('gradingConsumables.sleeveCost', 'GRADING_LOGISTICS', 'Assumed per-card sleeve cost (GBP)', '0.1', 'USER_SUPPLIED', 'A starting estimate — should be replaced with the operator''s actual supplier cost.', 1, datetime('now'), 'migration_0017_seed'),
  ('gradingConsumables.cardSaverCost', 'GRADING_LOGISTICS', 'Assumed per-card card-saver cost (GBP)', '0.2', 'USER_SUPPLIED', 'A starting estimate — should be replaced with the operator''s actual supplier cost.', 1, datetime('now'), 'migration_0017_seed'),
  ('fx.usdToGbp', 'FX_RATES', 'USD -> GBP conversion rate used for USD-denominated slab values/caps', '0.79', 'UNKNOWN', 'A static default (market/currency.ts DEFAULT_FX_RATES), overridable in Settings — no live FX API integration is confirmed wired up as of this migration, so unless the operator has manually refreshed this in Settings recently, treat it as stale. See item 12 audit: this is exactly the kind of number that LOOKS populated but may not reflect today''s real rate.', 1, datetime('now'), 'migration_0017_seed'),
  ('fx.eurToGbp', 'FX_RATES', 'EUR -> GBP conversion rate used for EUR-denominated market data', '0.86', 'UNKNOWN', 'Same caveat as fx.usdToGbp.', 1, datetime('now'), 'migration_0017_seed'),
  ('acquisitionCost.importTax', 'ACQUISITION_COST_GAPS', 'Import tax component of delivered acquisition cost', 'null', 'UNKNOWN', 'ITEM 12 AUDIT FINDING (confirmed in the SOURCING WORKFLOW final report, item 2): the calculation chain correctly ADDS this field when present, but real scans never actually populate it today — every real opportunity''s delivered cost is effectively price + postage only, with import tax silently assumed zero. Not a bug in the arithmetic; a genuine gap in what data reaches it.', 1, datetime('now'), 'migration_0017_seed'),
  ('acquisitionCost.acquisitionFees', 'ACQUISITION_COST_GAPS', 'Acquisition fees component of delivered acquisition cost (e.g. buyer-side platform fees)', 'null', 'UNKNOWN', 'Same finding as acquisitionCost.importTax — the field exists and is correctly summed when present, but no real scan populates it today.', 1, datetime('now'), 'migration_0017_seed');
