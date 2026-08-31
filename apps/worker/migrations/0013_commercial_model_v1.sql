-- V1 COMMERCIAL MODEL.
--
-- Replaces the placeholder economics with the real eBay UK business seller
-- cost model, a conservative sold-median QSV, data-driven grading services
-- with batch logistics, and economic classification of grading candidates.
--
-- Every commercial assumption lands in `settings` so it is editable from the
-- dashboard without a code change. Nothing here is a calculation constant.

-- ---------------------------------------------------------------------------
-- market_snapshots: keep the underlying sold data auditable
-- ---------------------------------------------------------------------------
ALTER TABLE market_snapshots ADD COLUMN raw_median_7d REAL;
ALTER TABLE market_snapshots ADD COLUMN raw_median_30d REAL;
ALTER TABLE market_snapshots ADD COLUMN qsv_basis TEXT;
ALTER TABLE market_snapshots ADD COLUMN is_high_confidence_qsv INTEGER;
ALTER TABLE market_snapshots ADD COLUMN psa6 REAL;

-- ---------------------------------------------------------------------------
-- opportunities: carry the full economics the dashboard now shows
-- ---------------------------------------------------------------------------
ALTER TABLE opportunities ADD COLUMN score REAL;
ALTER TABLE opportunities ADD COLUMN qualifies INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN qualification_failures TEXT;   -- json array
ALTER TABLE opportunities ADD COLUMN identity_confidence REAL;

-- FLIP
ALTER TABLE opportunities ADD COLUMN qsv_basis TEXT;
ALTER TABLE opportunities ADD COLUMN is_high_confidence_qsv INTEGER;
ALTER TABLE opportunities ADD COLUMN buyer_payment REAL;
ALTER TABLE opportunities ADD COLUMN selling_fees REAL;
ALTER TABLE opportunities ADD COLUMN profit_per_capital_day REAL;

-- GRADE
ALTER TABLE opportunities ADD COLUMN grader_id TEXT;
ALTER TABLE opportunities ADD COLUMN grading_service_id TEXT;
ALTER TABLE opportunities ADD COLUMN grading_service_name TEXT;
ALTER TABLE opportunities ADD COLUMN grade_rungs TEXT;              -- json: full ladder
ALTER TABLE opportunities ADD COLUMN psa10_value REAL;
ALTER TABLE opportunities ADD COLUMN psa10_gross_multiple REAL;
ALTER TABLE opportunities ADD COLUMN economic_class TEXT;
ALTER TABLE opportunities ADD COLUMN economic_class_rationale TEXT;
ALTER TABLE opportunities ADD COLUMN required_psa10_rate_vs_psa9 REAL;
ALTER TABLE opportunities ADD COLUMN required_psa10_rate_vs_psa8 REAL;
ALTER TABLE opportunities ADD COLUMN estimated_grading_days INTEGER;
ALTER TABLE opportunities ADD COLUMN estimated_capital_lock_days INTEGER;
ALTER TABLE opportunities ADD COLUMN annualised_roc_indicator REAL;
ALTER TABLE opportunities ADD COLUMN potential_upcharge INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN better_velocity_service_id TEXT;

CREATE INDEX idx_opportunities_qualifies ON opportunities(qualifies, score DESC);
CREATE INDEX idx_opportunities_economic_class ON opportunities(economic_class, score DESC);

-- ---------------------------------------------------------------------------
-- market_profiles: classification-driven eligibility
-- ---------------------------------------------------------------------------
ALTER TABLE grade_profiles ADD COLUMN economic_class TEXT;
ALTER TABLE grade_profiles ADD COLUMN economic_class_rationale TEXT;
ALTER TABLE grade_profiles ADD COLUMN required_psa10_rate_vs_psa9 REAL;
ALTER TABLE grade_profiles ADD COLUMN reference_service_id TEXT;
ALTER TABLE grade_profiles ADD COLUMN estimated_capital_lock_days INTEGER;
ALTER TABLE grade_profiles ADD COLUMN psa10_gross_multiple REAL;
ALTER TABLE flip_profiles ADD COLUMN qsv_basis TEXT;
ALTER TABLE flip_profiles ADD COLUMN is_high_confidence_qsv INTEGER;

-- ---------------------------------------------------------------------------
-- Realised economics: align with the new fee model (section 15)
-- ---------------------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN regulatory_operating_fee REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN per_order_fee REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN fee_vat REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN non_recoverable_fee_vat REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN buyer_paid_shipping REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN profit_per_day REAL;

ALTER TABLE grading_submissions ADD COLUMN service_id TEXT;
ALTER TABLE grading_submissions ADD COLUMN batch_id TEXT;
ALTER TABLE grading_submissions ADD COLUMN batch_size INTEGER;
ALTER TABLE grading_submissions ADD COLUMN allocated_batch_cost REAL;
ALTER TABLE grading_submissions ADD COLUMN actual_upcharge REAL NOT NULL DEFAULT 0;

-- Forecast is frozen at purchase and never recomputed from later data.
ALTER TABLE inventory ADD COLUMN forecast_snapshot TEXT;            -- json: the opportunity as forecast
ALTER TABLE inventory ADD COLUMN forecast_frozen_at TEXT;

-- ---------------------------------------------------------------------------
-- SETTINGS — every commercial assumption, editable from the dashboard
-- ---------------------------------------------------------------------------

-- eBay UK business seller fees. Published EXCLUSIVE of VAT; feeVatRate is
-- charged on top. sellerFeeVatRecoverable defaults FALSE (conservative:
-- treats fee VAT as a real cost). Promoted/international default to 0 —
-- V1 assumes a UK buyer and no ad rate.
INSERT INTO settings (key, value, description) VALUES (
  'exit_market_fees',
  '{"finalValueFeePct":0.109,"regulatoryOperatingFeePct":0.0035,"perOrderFee":0.40,"perOrderFeeThreshold":10,"perOrderFeeBelowThreshold":0.40,"promotedListingsPct":0,"internationalFeePct":0,"feeVatRate":0.20,"sellerFeeVatRecoverable":false}',
  'eBay UK business seller fee model. Fees are published ex-VAT; feeVatRate applies on top. Set sellerFeeVatRecoverable true only if you reclaim input VAT on marketplace fees.'
);

-- Our own selling-side costs, split raw vs graded (slabs ship heavier).
INSERT INTO settings (key, value, description) VALUES (
  'selling_costs',
  '{"outboundPostage":1.55,"outboundPostageGraded":4.50,"packaging":0.75,"saleInsurance":0,"saleInsuranceGraded":2.50}',
  'Our outbound fulfilment costs when selling. Graded variants apply to slab sales.'
);

-- QSV: lower of the 7d/30d SOLD medians, less a quick-sale haircut.
INSERT INTO settings (key, value, description) VALUES (
  'qsv_settings',
  '{"quickSaleHaircutPct":0.08,"singleMedianConfidenceMultiplier":0.75,"fallbackConfidenceCeiling":0.35}',
  'Quick Sale Value model. QSV = min(7d sold median, 30d sold median) x (1 - haircut). Active asking prices never contribute.'
);

-- Graders. Only enable one once raw-to-grade pricing, sold slab pricing,
-- liquidity and exact grade-tier mapping are all validated for it.
INSERT INTO settings (key, value, description) VALUES (
  'graders',
  '[{"id":"PSA","name":"PSA","enabled":true,"disabledReason":null},{"id":"BGS","name":"Beckett (BGS)","enabled":false,"disabledReason":"Supported but disabled until BGS sold-slab pricing, liquidity and grade-tier mapping are validated."},{"id":"CGC","name":"CGC","enabled":false,"disabledReason":"Supported but disabled until CGC sold-slab pricing, liquidity and grade-tier mapping are validated."}]',
  'Grading companies. A grader is only enabled for arbitrage when its resale market data is reliable — cheap grading is not a reason to enable one.'
);

-- Grading service tiers as DATA. Turnaround figures are ESTIMATES.
INSERT INTO settings (key, value, description) VALUES (
  'grading_services',
  '[{"id":"PSA_REGULAR","graderId":"PSA","name":"PSA Regular","feePerCard":65,"estimatedTurnaroundBusinessDays":75,"declaredValueCapUsd":1500,"enabled":true},{"id":"PSA_VALUE","graderId":"PSA","name":"PSA Value","feePerCard":23,"estimatedTurnaroundBusinessDays":160,"declaredValueCapUsd":500,"enabled":true}]',
  'Grading service tiers. declaredValueCapUsd is the service final-value limit — a slab valued above it may be upcharged. Turnaround days are estimates, not guarantees.'
);

-- Batch logistics. Postage/insurance to and from the grader are shared
-- across a submission, NOT charged per card.
INSERT INTO settings (key, value, description) VALUES (
  'grading_batch',
  '{"batchSize":10,"batchOutboundPostage":15,"batchReturnPostage":20,"batchInsurance":12}',
  'Grading submission batch assumptions. Shared logistics are divided by batchSize; replace with actual batch costs once a real submission happens.'
);

INSERT INTO settings (key, value, description) VALUES (
  'grading_consumables',
  '{"sleeveCost":0.10,"cardSaverCost":0.20}',
  'Genuinely per-card grading consumables. NOT divided by batch size.'
);

INSERT INTO settings (key, value, description) VALUES (
  'upcharge_settings',
  '{"estimatedUpchargeCost":40,"includeReserveInBasis":false}',
  'Declared-value upcharge reserve. The exact escalation is unknown before submission, so this is an estimate and is flagged rather than assumed.'
);

-- Economic classification thresholds (section 5).
INSERT INTO settings (key, value, description) VALUES (
  'grade_classification',
  '{"downsideProtectedMinPsa7Profit":0,"balancedMaxPsa8LossPctOfBasis":0.10,"balancedMinPsa9Profit":40,"balancedMinPsa9ProfitPctOfBasis":0.25,"asymmetricMinPsa10Profit":500,"asymmetricMinPsa10GrossMultiple":5}',
  'Thresholds separating DOWNSIDE PROTECTED / BALANCED / ASYMMETRIC grading structures.'
);

-- Raw flip qualification: BOTH conditions must pass.
INSERT INTO settings (key, value, description) VALUES (
  'flip_qualification',
  '{"minNetProfit":40,"minReturnOnCapital":0.40,"maxAcquisitionCost":500,"minQsv":20,"minLiquidity":"MEDIUM","minConfidence":0.6,"maxExpectedDaysToSale":30}',
  'Raw flip qualification. TRUE NET PROFIT >= £40 AND ROC >= 40% — both required. Percentage ROC alone never qualifies a small flip.'
);

-- Grade qualification. Permissive on structure, strict on data quality.
INSERT INTO settings (key, value, description) VALUES (
  'grade_qualification',
  '{"enabledEconomicClasses":["DOWNSIDE_PROTECTED","BALANCED","ASYMMETRIC"],"maxRawAcquisitionCost":1000,"maxTotalGradedBasis":1500,"minPsa10Value":80,"minPsa10Profit":0,"minPsa10GrossMultiple":0,"minPsa9Profit":null,"maxPsa8LossPctOfBasis":1,"maxBreakEvenGrade":null,"maxRequiredPsa10Rate":1,"minLiquidity":"LOW","minConfidence":0.5,"maxEstimatedCapitalLockDays":400,"enabledGraderIds":["PSA"],"enabledServiceIds":["PSA_REGULAR","PSA_VALUE"]}',
  'Grading qualification rules. All three economic classes are enabled by default so asymmetric opportunities are discovered, not filtered away. null means the rule is not applied.'
);

-- Grade score weights, rewritten for the new ranking criteria.
UPDATE settings
SET value = '{"downsideProtection":0.25,"psa9Economics":0.20,"psa10Upside":0.15,"requiredHitRate":0.15,"slabLiquidity":0.10,"capitalVelocity":0.10,"dataConfidence":0.05}',
    description = 'GRADE ranking weights. Score orders qualifying opportunities only — it never decides qualification.',
    updated_at = datetime('now')
WHERE key = 'grade_score_weights';

-- Catalogue-level profile settings: classification replaces the old
-- break-even-grade cutoff, which silently discarded asymmetric candidates.
UPDATE settings
SET value = '{"minFlipRawValue":5,"minFlipLiquidity":"LOW","minFlipConfidence":0.4,"minGradeRawValue":5,"minGradeConfidence":0.4,"eligibleEconomicClasses":["DOWNSIDE_PROTECTED","BALANCED","ASYMMETRIC"]}',
    description = 'Coarse pre-eBay catalogue eligibility. Deliberately looser than per-listing qualification — a card can be dull at market price and excellent at an underpriced listing.',
    updated_at = datetime('now')
WHERE key = 'market_profile_settings';

-- The old fee schedule carried a 13.25% FVF, a £0.30 order fee, a
-- non-existent payment-processing percentage, a hardcoded £65 PSA fee and
-- per-card grading postage. It is superseded by exit_market_fees /
-- selling_costs / grading_* above. Kept (not deleted) so any historical
-- forecast that referenced it stays interpretable.
UPDATE settings
SET description = 'SUPERSEDED by exit_market_fees, selling_costs, grading_services, grading_batch and grading_consumables (migration 0013). Retained only so historical forecasts remain interpretable. Not read by the engine.',
    updated_at = datetime('now')
WHERE key = 'fee_schedule';

UPDATE settings
SET description = 'SUPERSEDED by flip_qualification and grade_qualification (migration 0013). Not read by the engine.',
    updated_at = datetime('now')
WHERE key IN ('global_filters', 'flip_filters', 'grade_filters');
