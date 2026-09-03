import { Db, type OpportunityRow, type LearningReviewSnapshotRow } from "@mwmc/db";
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
       reasoning, review_status, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
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
       updated_at = datetime('now')
       -- SOURCING WORKFLOW item 17 (review-status workflow): review_status
       -- (and review_notes/reviewed_at, set separately by
       -- updateOpportunityReview below) are DELIBERATELY NOT in this SET
       -- clause. A re-scan re-upserts the SAME row (same listing_id+strategy
       -- -> same id, see the "existing" lookup above) every time this
       -- listing is still found, and a human's manual sourcing decision on
       -- it must survive
       -- that — only the INSERT branch below sets an initial 'UNREVIEWED'
       -- for a genuinely new row; ON CONFLICT leaves whatever's already
       -- there untouched.`,
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
    "UNREVIEWED",
  );

  return existing ? "updated" : "created";
}

export type ReviewStatus = "UNREVIEWED" | "CHECKED" | "INTERESTED" | "PASS" | "BOUGHT";

export const REVIEW_STATUSES: ReviewStatus[] = ["UNREVIEWED", "CHECKED", "INTERESTED", "PASS", "BOUGHT"];

/**
 * AI INTELLIGENCE spec item 20 (pass/fail reason codes). A CLOSED
 * vocabulary for WHY a human made a review decision — review_notes stays
 * free text for anything this list doesn't capture; this is the
 * structured, aggregable counterpart a later calibration pass can actually
 * count and group by. Deliberately covers PASS reasons (the highest-value
 * training signal — why did a human reject something the engine thought
 * qualified) and BOUGHT reasons together, since the same code list is
 * meaningful for both ("CONDITION_CONCERN" explains both a pass and,
 * later, why a buy went ahead anyway after inspection). Optional on every
 * review update — never required, because forcing a code onto a decision
 * that genuinely doesn't fit any of them would produce false signal, which
 * is worse than no signal.
 */
export const REVIEW_REASON_CODES = [
  "PRICE_TOO_HIGH_VS_COMPS",
  "CONDITION_CONCERN",
  "SELLER_RISK",
  "LOW_CONFIDENCE_CARD_IDENTITY",
  "LIKELY_ALREADY_GRADED",
  "LIKELY_LOT_OR_BUNDLE",
  "THIN_MARKET_DATA",
  "DUPLICATE_OF_BETTER_LISTING",
  "ALREADY_OWN_THIS_CARD",
  "AUCTION_PRICE_RISK",
  "BUDGET_CONSTRAINT",
  "GOOD_OPPORTUNITY_AS_FORECAST",
  "OTHER",
] as const;
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

/**
 * SOURCING WORKFLOW item 17 (review-status workflow): the manual sourcing
 * decision a human makes about a specific opportunity — separate from, and
 * never influencing, the engine's own computed `state`/`qualifies`. Any of
 * the three fields may be omitted to leave it unchanged. Always stamps
 * `reviewed_at` (a real "last touched" timestamp) whenever anything
 * changes, even if only the notes changed and the status stayed the same.
 *
 * AI INTELLIGENCE spec items 19-20: on any change, ALSO writes an immutable
 * learning_review_snapshots row (captureLearningReviewSnapshot below) — see
 * migration 0018's doc comment for why this exists alongside, not instead
 * of, inventory.forecast_snapshot. Captured from the row's state BEFORE
 * this update is applied, since the point is "what did the human see when
 * they decided", not the row after their own edit changed it.
 */
export async function updateOpportunityReview(
  db: Db,
  id: string,
  update: { reviewStatus?: ReviewStatus; reviewNotes?: string | null; reviewReasonCode?: ReviewReasonCode | null },
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (update.reviewStatus !== undefined) {
    sets.push("review_status = ?");
    params.push(update.reviewStatus);
  }
  if (update.reviewNotes !== undefined) {
    sets.push("review_notes = ?");
    // An empty string is treated as "no notes" (null), not a real note —
    // avoids a round-trip of clearing the textarea leaving a stray "".
    params.push(update.reviewNotes === "" ? null : update.reviewNotes);
  }
  if (update.reviewReasonCode !== undefined) {
    sets.push("review_reason_code = ?");
    params.push(update.reviewReasonCode);
  }
  if (sets.length === 0) return false;

  const before = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, id);
  if (!before) return false;

  sets.push("reviewed_at = datetime('now')");
  params.push(id);

  const result = await db.exec(`UPDATE opportunities SET ${sets.join(", ")} WHERE id = ?`, ...params);
  if (!result.success) return false;

  await captureLearningReviewSnapshot(db, before, {
    reviewStatus: update.reviewStatus ?? before.review_status,
    reviewReasonCode: update.reviewReasonCode !== undefined ? update.reviewReasonCode : before.review_reason_code,
    reviewNotes: update.reviewNotes !== undefined ? (update.reviewNotes === "" ? null : update.reviewNotes) : before.review_notes,
  });

  return true;
}

/**
 * AI INTELLIGENCE spec items 19-20 (learning database). Writes an
 * immutable copy of the opportunity's full computed state at the moment a
 * review decision was recorded — never updated afterward, so a later
 * rescan overwriting the LIVE opportunities row (see upsertOpportunity's
 * ON CONFLICT clause above) can never quietly rewrite what a human actually
 * saw when they decided. `beforeRow` is the opportunities row as it stood
 * BEFORE the review fields on it were changed, so `opportunity_snapshot`
 * reflects the economics the human was actually looking at.
 */
export async function captureLearningReviewSnapshot(
  db: Db,
  beforeRow: OpportunityRow,
  decision: { reviewStatus: string; reviewReasonCode: string | null; reviewNotes: string | null },
): Promise<void> {
  await db.exec(
    `INSERT INTO learning_review_snapshots (id, opportunity_id, review_status, review_reason_code, review_notes, opportunity_snapshot, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    crypto.randomUUID(),
    beforeRow.id,
    decision.reviewStatus,
    decision.reviewReasonCode,
    decision.reviewNotes,
    JSON.stringify(beforeRow),
  );
}

export async function listLearningReviewSnapshots(db: Db, opportunityId: string): Promise<LearningReviewSnapshotRow[]> {
  return db.queryAll<LearningReviewSnapshotRow>(
    `SELECT * FROM learning_review_snapshots WHERE opportunity_id = ? ORDER BY captured_at DESC`,
    opportunityId,
  );
}

/**
 * AI INTELLIGENCE spec item 28 (deterministic capital allocation). One row
 * per currently QUALIFIED opportunity (QUALIFIED_FLIP or QUALIFIED_GRADE —
 * INSPECT_PHOTOS is deliberately excluded, since its identity is not yet
 * trusted enough to commit real capital to it), shaped as the input the
 * pure allocateCapital() in packages/core/src/calc/capitalAllocation.ts
 * expects. Deliberately a live query, not a cached/derived table — an
 * allocation decision should always run against what's qualified RIGHT NOW.
 */
export interface CapitalAllocationCandidateRow {
  id: string;
  cardPrintingHash: string | null;
  strategy: "FLIP" | "GRADE";
  totalAcquisitionCost: number;
  profitPerCapitalDay: number | null;
}

export async function listCapitalAllocationCandidates(db: Db): Promise<CapitalAllocationCandidateRow[]> {
  const rows = await db.queryAll<{
    id: string;
    card_id: string;
    strategy: "FLIP" | "GRADE";
    total_acquisition_cost: number;
    profit_per_capital_day: number | null;
  }>(
    `SELECT id, card_id, strategy, total_acquisition_cost, profit_per_capital_day
     FROM opportunities
     WHERE state IN ('QUALIFIED_FLIP', 'QUALIFIED_GRADE')`,
  );
  return rows.map((r) => ({
    id: r.id,
    cardPrintingHash: r.card_id,
    strategy: r.strategy,
    totalAcquisitionCost: r.total_acquisition_cost,
    profitPerCapitalDay: r.profit_per_capital_day,
  }));
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
  /** STABILISATION item 8 (freshness) — opportunities whose underlying
   *  listing has since been marked ENDED (currently: an auction past its
   *  end_time — see expireEndedAuctionListings()). Surfaced, never
   *  auto-hidden, so a stale row is visible as stale rather than silently
   *  dropped. */
  endedListings: number;
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
  const [stateRows, auctionRow, endedRow] = await Promise.all([
    db.queryAll<{ state: string; n: number }>(`SELECT state, COUNT(*) as n FROM opportunities GROUP BY state`),
    db.queryFirst<{ n: number }>(
      `SELECT COUNT(*) as n FROM opportunities o JOIN ebay_listings l ON l.id = o.listing_id WHERE l.listing_type = 'AUCTION'`,
    ),
    db.queryFirst<{ n: number }>(
      `SELECT COUNT(*) as n FROM opportunities o JOIN ebay_listings l ON l.id = o.listing_id WHERE l.status != 'ACTIVE'`,
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
    endedListings: endedRow?.n ?? 0,
    byState,
  };
}
