import { Db } from "@mwmc/db";
import type { OpportunityCandidate } from "@mwmc/core";
import { QUALIFIED_STATES } from "@mwmc/core";

/**
 * Persists one forecast opportunity.
 *
 * FORECAST ONLY. Every number written here is what the engine believed at
 * scan time, and is never recomputed from later realised data — realised
 * economics live in `inventory` / `grading_submissions` / `transactions`
 * and are compared against a frozen copy of this forecast (see
 * inventory.forecast_snapshot, migration 0013).
 */
export async function upsertOpportunity(
  db: Db,
  candidate: OpportunityCandidate,
  scanRunId: string,
): Promise<
  | "created"
  | "updated"
  | "skipped_identity_uncertain"
  | "skipped_uncatalogued_card"
  | "skipped_no_market_data"
  | "skipped_computation_error"
> {
  if (!candidate.cardPrintingHash) {
    // Identity-uncertain candidates aren't tied to a resolved card, so
    // there's nothing stable to upsert against — nothing is written to the
    // `opportunities` table for this listing. Reported as its own outcome
    // so the scan summary isn't misleading about what's in the database.
    return "skipped_identity_uncertain";
  }

  // Three states carry no computed liquidity (see
  // packages/core/src/opportunity/engine.ts): NO_MARKET_DATA — identity
  // resolved and catalogued, but no market snapshot exists yet to price it
  // against; REJECTED_CARD_IDENTITY_UNCERTAIN when identity resolved to a
  // printing but at too-low confidence to trust; and REJECTED_COMPUTATION_ERROR
  // when the listing's own numbers (price, currency, ...) were rejected by
  // the economics calculators. `opportunities.liquidity` is NOT NULL by
  // design: every row in that table is meant to be a real, priced candidate,
  // so a state with no economics has nothing to persist.
  if (candidate.liquidity === null) {
    if (candidate.state === "NO_MARKET_DATA") return "skipped_no_market_data";
    if (candidate.state === "REJECTED_COMPUTATION_ERROR") return "skipped_computation_error";
    return "skipped_identity_uncertain";
  }

  // A listing can resolve cleanly to a printing we have simply never
  // catalogued — an eBay search for one card routinely returns others, and
  // the catalogue is always a subset of what's for sale. `opportunities.card_id`
  // is a foreign key into `cards`, so writing one of these blind raises
  // D1_ERROR: FOREIGN KEY constraint failed, which previously propagated out
  // of the scan loop and failed the ENTIRE scan run on the first such
  // listing. Checking first turns a scan-killing error into one skipped row.
  const catalogued = await db.queryFirst<{ id: string }>(
    `SELECT id FROM cards WHERE id = ?`,
    candidate.cardPrintingHash,
  );
  if (!catalogued) {
    return "skipped_uncatalogued_card";
  }

  const existing = await db.queryFirst<{ id: string }>(
    `SELECT id FROM opportunities WHERE listing_id = ? AND strategy = ?`,
    candidate.listingId,
    candidate.strategy,
  );

  const id = existing?.id ?? crypto.randomUUID();

  await db.exec(
    `INSERT INTO opportunities (
       id, card_id, listing_id, scan_run_id, strategy, state,
       score, qualifies, qualification_failures, identity_confidence,
       flip_score, grade_score,
       listing_price, total_acquisition_cost, liquidity, confidence,
       qsv, qsv_basis, is_high_confidence_qsv, buyer_payment, selling_fees,
       expected_net_sale_proceeds, expected_net_profit, return_on_capital, profit_margin,
       days_to_sale_estimate, profit_per_capital_day,
       grader_id, grading_service_id, grading_service_name,
       total_graded_basis, grade_rungs,
       psa6_profit, psa7_profit, psa8_profit, psa9_profit, psa10_profit,
       psa10_value, break_even_grade, psa10_upside_multiple, psa10_gross_multiple,
       economic_class, economic_class_rationale,
       required_psa10_rate_vs_psa9, required_psa10_rate_vs_psa8,
       estimated_grading_days, estimated_capital_lock_days, annualised_roc_indicator,
       potential_upcharge, better_velocity_service_id,
       reasoning, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       score = excluded.score,
       qualifies = excluded.qualifies,
       qualification_failures = excluded.qualification_failures,
       identity_confidence = excluded.identity_confidence,
       flip_score = excluded.flip_score,
       grade_score = excluded.grade_score,
       listing_price = excluded.listing_price,
       total_acquisition_cost = excluded.total_acquisition_cost,
       liquidity = excluded.liquidity,
       confidence = excluded.confidence,
       qsv = excluded.qsv,
       qsv_basis = excluded.qsv_basis,
       is_high_confidence_qsv = excluded.is_high_confidence_qsv,
       buyer_payment = excluded.buyer_payment,
       selling_fees = excluded.selling_fees,
       expected_net_sale_proceeds = excluded.expected_net_sale_proceeds,
       expected_net_profit = excluded.expected_net_profit,
       return_on_capital = excluded.return_on_capital,
       profit_margin = excluded.profit_margin,
       days_to_sale_estimate = excluded.days_to_sale_estimate,
       profit_per_capital_day = excluded.profit_per_capital_day,
       grader_id = excluded.grader_id,
       grading_service_id = excluded.grading_service_id,
       grading_service_name = excluded.grading_service_name,
       total_graded_basis = excluded.total_graded_basis,
       grade_rungs = excluded.grade_rungs,
       psa6_profit = excluded.psa6_profit,
       psa7_profit = excluded.psa7_profit,
       psa8_profit = excluded.psa8_profit,
       psa9_profit = excluded.psa9_profit,
       psa10_profit = excluded.psa10_profit,
       psa10_value = excluded.psa10_value,
       break_even_grade = excluded.break_even_grade,
       psa10_upside_multiple = excluded.psa10_upside_multiple,
       psa10_gross_multiple = excluded.psa10_gross_multiple,
       economic_class = excluded.economic_class,
       economic_class_rationale = excluded.economic_class_rationale,
       required_psa10_rate_vs_psa9 = excluded.required_psa10_rate_vs_psa9,
       required_psa10_rate_vs_psa8 = excluded.required_psa10_rate_vs_psa8,
       estimated_grading_days = excluded.estimated_grading_days,
       estimated_capital_lock_days = excluded.estimated_capital_lock_days,
       annualised_roc_indicator = excluded.annualised_roc_indicator,
       potential_upcharge = excluded.potential_upcharge,
       better_velocity_service_id = excluded.better_velocity_service_id,
       scan_run_id = excluded.scan_run_id,
       reasoning = excluded.reasoning,
       updated_at = datetime('now')`,
    id,
    candidate.cardPrintingHash,
    candidate.listingId,
    scanRunId,
    candidate.strategy,
    candidate.state,
    candidate.score,
    candidate.qualifies ? 1 : 0,
    candidate.qualificationFailures.length > 0 ? JSON.stringify(candidate.qualificationFailures) : null,
    candidate.identityConfidence,
    // flip_score / grade_score are kept as strategy-specific mirrors of the
    // single ranking score, so existing indexes and queries keep working.
    candidate.strategy === "FLIP" ? candidate.score : null,
    candidate.strategy === "GRADE" ? candidate.score : null,
    candidate.listingPrice,
    candidate.totalAcquisitionCost,
    candidate.liquidity,
    candidate.confidence,
    candidate.qsv ?? null,
    candidate.qsvBasis ?? null,
    candidate.isHighConfidenceQsv === undefined ? null : candidate.isHighConfidenceQsv ? 1 : 0,
    candidate.buyerPayment ?? null,
    candidate.sellingFees ?? null,
    candidate.expectedNetSaleProceeds ?? null,
    candidate.expectedNetProfit ?? null,
    candidate.returnOnCapital ?? null,
    candidate.profitMargin ?? null,
    candidate.expectedDaysToSale ?? null,
    candidate.profitPerCapitalDay ?? null,
    candidate.graderId ?? null,
    candidate.gradingServiceId ?? null,
    candidate.gradingServiceName ?? null,
    candidate.totalGradedBasis ?? null,
    candidate.gradeRungs ? JSON.stringify(candidate.gradeRungs) : null,
    candidate.psa6Profit ?? null,
    candidate.psa7Profit ?? null,
    candidate.psa8Profit ?? null,
    candidate.psa9Profit ?? null,
    candidate.psa10Profit ?? null,
    candidate.psa10Value ?? null,
    candidate.breakEvenGrade ?? null,
    candidate.psa10GrossMultiple ?? null,
    candidate.psa10GrossMultiple ?? null,
    candidate.economicClass ?? null,
    candidate.economicClassRationale ?? null,
    candidate.requiredPsa10RateVsPsa9 ?? null,
    candidate.requiredPsa10RateVsPsa8 ?? null,
    candidate.estimatedGradingDays ?? null,
    candidate.estimatedCapitalLockDays ?? null,
    candidate.annualisedRocIndicator ?? null,
    candidate.potentialUpcharge ? 1 : 0,
    candidate.betterVelocityServiceId ?? null,
    JSON.stringify(candidate.reasoning),
  );

  return existing ? "updated" : "created";
}

export interface OpportunityCounts {
  totalCandidates: number;
  qualifiedFlip: number;
  qualifiedGrade: number;
  inspectPhotos: number;
  qualifiedTotal: number;
  watch: number;
  noMarketData: number;
  identityUncertain: number;
  computationError: number;
  auctions: number;
  byState: Record<string, number>;
}

/**
 * STABILISATION item 1: independent-of-filter breakdown of every stored
 * opportunity, so the dashboard can show "412 total candidates / 18
 * qualified flips / 26 grading candidates / 43 auctions / ... / 294
 * rejected" honestly instead of only ever describing whatever fit on the
 * current page. Deliberately a second, unfiltered query — not derived from
 * a paged result set — so the counts stay accurate no matter what the user
 * is currently filtering or paging through.
 */
export async function loadOpportunityCounts(db: Db): Promise<OpportunityCounts> {
  const [stateRows, auctionRow] = await Promise.all([
    db.queryAll<{ state: string; n: number }>(`SELECT state, COUNT(*) as n FROM opportunities GROUP BY state`),
    db.queryFirst<{ n: number }>(
      `SELECT COUNT(*) as n FROM opportunities o JOIN ebay_listings l ON l.id = o.listing_id WHERE l.listing_type = 'AUCTION'`,
    ),
  ]);

  const byState: Record<string, number> = {};
  let totalCandidates = 0;
  for (const row of stateRows) {
    byState[row.state] = row.n;
    totalCandidates += row.n;
  }

  return {
    totalCandidates,
    qualifiedFlip: byState["QUALIFIED_FLIP"] ?? 0,
    qualifiedGrade: byState["QUALIFIED_GRADE"] ?? 0,
    inspectPhotos: byState["INSPECT_PHOTOS"] ?? 0,
    qualifiedTotal: QUALIFIED_STATES.reduce((sum, s) => sum + (byState[s] ?? 0), 0),
    watch: byState["WATCH"] ?? 0,
    noMarketData: byState["NO_MARKET_DATA"] ?? 0,
    identityUncertain: byState["REJECTED_CARD_IDENTITY_UNCERTAIN"] ?? 0,
    computationError: byState["REJECTED_COMPUTATION_ERROR"] ?? 0,
    auctions: auctionRow?.n ?? 0,
    byState,
  };
}
