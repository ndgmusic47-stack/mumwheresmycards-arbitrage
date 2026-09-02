import { Db, type CardRow, type FlipProfileRow, type GradeProfileRow } from "@mwmc/db";
import type { FlipProfileResult, GradeProfileResult, PrioritizableCard } from "@mwmc/core";
import { QUALIFIED_STATES } from "@mwmc/core";

/**
 * Cards due for a market-profile (re)computation: never profiled yet, or
 * profiled longer ago than `staleHours`. Never-profiled cards sort first
 * so a growing catalogue always finishes onboarding new cards before
 * refreshing ones it already has an opinion on. Capped at `limit` per call
 * — see settings key `market_profile_settings`/scanRunner.ts for the
 * per-run budget this protects.
 */
export async function selectCardsNeedingProfileRefresh(db: Db, limit: number, staleHours: number): Promise<CardRow[]> {
  return db.queryAll<CardRow>(
    `SELECT c.* FROM cards c
     LEFT JOIN flip_profiles fp ON fp.card_id = c.id
     WHERE fp.card_id IS NULL OR fp.computed_at < datetime('now', '-' || ? || ' hours')
     ORDER BY (fp.computed_at IS NULL) DESC, fp.computed_at ASC
     LIMIT ?`,
    staleHours,
    limit,
  );
}

export async function upsertFlipProfile(
  db: Db,
  cardId: string,
  marketSnapshotId: number | null,
  rawSampleSize: number | null,
  profile: FlipProfileResult,
): Promise<void> {
  await db.exec(
    `INSERT INTO flip_profiles (
       card_id, market_snapshot_id, raw_market_value, conservative_qsv, qsv_basis, is_high_confidence_qsv,
       raw_sample_size, liquidity, confidence,
       max_profitable_acquisition_price, eligible, flip_market_score, ineligible_reason, computed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(card_id) DO UPDATE SET
       market_snapshot_id = excluded.market_snapshot_id,
       raw_market_value = excluded.raw_market_value,
       conservative_qsv = excluded.conservative_qsv,
       qsv_basis = excluded.qsv_basis,
       is_high_confidence_qsv = excluded.is_high_confidence_qsv,
       raw_sample_size = excluded.raw_sample_size,
       liquidity = excluded.liquidity,
       confidence = excluded.confidence,
       max_profitable_acquisition_price = excluded.max_profitable_acquisition_price,
       eligible = excluded.eligible,
       flip_market_score = excluded.flip_market_score,
       ineligible_reason = excluded.ineligible_reason,
       computed_at = datetime('now')`,
    cardId,
    marketSnapshotId,
    profile.rawMarketValue,
    profile.conservativeQsv,
    profile.qsvBasis,
    profile.isHighConfidenceQsv ? 1 : 0,
    rawSampleSize,
    profile.liquidity,
    profile.confidence,
    profile.maxProfitableAcquisitionPrice,
    profile.eligible ? 1 : 0,
    profile.flipMarketScore,
    profile.ineligibleReason,
  );
}

export async function upsertGradeProfile(
  db: Db,
  cardId: string,
  marketSnapshotId: number | null,
  rawSampleSize: number | null,
  profile: GradeProfileResult,
): Promise<void> {
  await db.exec(
    `INSERT INTO grade_profiles (
       card_id, market_snapshot_id, raw_market_value, psa7, psa8, psa9, psa10, raw_sample_size,
       reference_graded_basis, reference_psa7_profit, reference_psa8_profit, reference_psa9_profit, reference_psa10_profit,
       break_even_grade, psa10_upside_multiple, psa10_gross_multiple, economic_class, economic_class_rationale,
       required_psa10_rate_vs_psa9, reference_service_id, estimated_capital_lock_days,
       liquidity, confidence, eligible, grade_market_score, ineligible_reason, computed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(card_id) DO UPDATE SET
       market_snapshot_id = excluded.market_snapshot_id,
       raw_market_value = excluded.raw_market_value,
       psa7 = excluded.psa7, psa8 = excluded.psa8, psa9 = excluded.psa9, psa10 = excluded.psa10,
       raw_sample_size = excluded.raw_sample_size,
       reference_graded_basis = excluded.reference_graded_basis,
       reference_psa7_profit = excluded.reference_psa7_profit,
       reference_psa8_profit = excluded.reference_psa8_profit,
       reference_psa9_profit = excluded.reference_psa9_profit,
       reference_psa10_profit = excluded.reference_psa10_profit,
       break_even_grade = excluded.break_even_grade,
       psa10_upside_multiple = excluded.psa10_upside_multiple,
       psa10_gross_multiple = excluded.psa10_gross_multiple,
       economic_class = excluded.economic_class,
       economic_class_rationale = excluded.economic_class_rationale,
       required_psa10_rate_vs_psa9 = excluded.required_psa10_rate_vs_psa9,
       reference_service_id = excluded.reference_service_id,
       estimated_capital_lock_days = excluded.estimated_capital_lock_days,
       liquidity = excluded.liquidity,
       confidence = excluded.confidence,
       eligible = excluded.eligible,
       grade_market_score = excluded.grade_market_score,
       ineligible_reason = excluded.ineligible_reason,
       computed_at = datetime('now')`,
    cardId,
    marketSnapshotId,
    profile.rawMarketValue,
    profile.psa7,
    profile.psa8,
    profile.psa9,
    profile.psa10,
    rawSampleSize,
    profile.referenceGradedBasis,
    profile.referenceProfitByGrade[7] ?? null,
    profile.referenceProfitByGrade[8] ?? null,
    profile.referenceProfitByGrade[9] ?? null,
    profile.referenceProfitByGrade[10] ?? null,
    profile.breakEvenGrade,
    // psa10_upside_multiple is the legacy column name; the model now
    // reports a GROSS multiple explicitly. Both are written so historical
    // rows stay comparable and the new field is queryable by its own name.
    profile.psa10GrossMultiple,
    profile.psa10GrossMultiple,
    profile.economicClass,
    profile.economicClassRationale,
    profile.requiredPsa10RateVsPsa9,
    profile.referenceServiceId,
    profile.estimatedCapitalLockDays,
    profile.liquidity,
    profile.confidence,
    profile.eligible ? 1 : 0,
    profile.gradeMarketScore,
    profile.ineligibleReason,
  );
}

/**
 * Every card eligible for FLIP and/or GRADE — the Dynamic Flip/Grade
 * Universe — merged into one prioritizable-card view for the eBay-search
 * ranking step (packages/core/src/market/prioritization.ts). A card
 * eligible in both strategies takes the higher score/profit signal from
 * either, since we only search eBay once per card regardless of strategy.
 */
export async function listEligibleUniverseCards(db: Db): Promise<Map<string, PrioritizableCard>> {
  const flipRows = await db.queryAll<FlipProfileRow & Pick<CardRow, "last_ebay_scanned_at">>(
    `SELECT fp.*, c.last_ebay_scanned_at FROM flip_profiles fp JOIN cards c ON c.id = fp.card_id WHERE fp.eligible = 1`,
  );
  const gradeRows = await db.queryAll<GradeProfileRow & Pick<CardRow, "last_ebay_scanned_at">>(
    `SELECT gp.*, c.last_ebay_scanned_at FROM grade_profiles gp JOIN cards c ON c.id = gp.card_id WHERE gp.eligible = 1`,
  );

  const merged = new Map<string, PrioritizableCard>();

  for (const row of flipRows) {
    merged.set(row.card_id, {
      cardId: row.card_id,
      score: row.flip_market_score,
      potentialProfit: row.max_profitable_acquisition_price,
      liquidity: row.liquidity,
      confidence: row.confidence,
      lastEbayScannedAt: row.last_ebay_scanned_at,
      // flip_profiles.max_profitable_acquisition_price already IS "the
      // highest all-in acquisition cost that still clears the flip bar"
      // (see flipProfile.ts's own doc comment) — a ready-made, exact ceiling.
      maxAcquisitionPrice: row.max_profitable_acquisition_price,
    });
  }

  for (const row of gradeRows) {
    const existing = merged.get(row.card_id);
    const candidateProfit = row.reference_psa10_profit ?? row.reference_psa9_profit ?? null;
    const gradeCeiling = deriveGradeMaxAcquisitionPrice(row);
    if (!existing) {
      merged.set(row.card_id, {
        cardId: row.card_id,
        score: row.grade_market_score,
        potentialProfit: candidateProfit,
        liquidity: row.liquidity,
        confidence: row.confidence,
        lastEbayScannedAt: row.last_ebay_scanned_at,
        maxAcquisitionPrice: gradeCeiling,
      });
    } else {
      existing.score = Math.max(existing.score ?? 0, row.grade_market_score ?? 0);
      existing.potentialProfit = Math.max(existing.potentialProfit ?? 0, candidateProfit ?? 0);
      // A card eligible under BOTH strategies must use whichever ceiling is
      // HIGHER, never the lower one — capping a search at the flip ceiling
      // could silently hide a listing priced above it that's still a
      // genuine grading opportunity, and vice versa. A null on either side
      // means "no safe ceiling from that strategy", not "zero" — only
      // combine the two when both are actually known.
      existing.maxAcquisitionPrice =
        existing.maxAcquisitionPrice === null || gradeCeiling === null
          ? (existing.maxAcquisitionPrice ?? gradeCeiling)
          : Math.max(existing.maxAcquisitionPrice, gradeCeiling);
    }
  }

  return merged;
}

/**
 * STABILISATION item 11: flip_profiles gives a ready-made acquisition
 * ceiling (max_profitable_acquisition_price), but grade_profiles does not —
 * it stores per-grade REFERENCE profit at a reference acquisition price of
 * raw_market_value (see gradeProfile.ts). Profit falls roughly £1-for-£1 as
 * the acquisition price rises (fees/grading costs are independent of
 * purchase price), so the breakeven acquisition price for a given grade is
 * raw_market_value + that grade's reference profit. Using the BEST grade's
 * reference profit (not just PSA10 — a card can be economically ASYMMETRIC
 * or BALANCED in a way where a lower grade carries the highest reference
 * profit) gives the true highest acquisition price at which ANY grade
 * outcome could still be profitable — genuinely safe to filter eBay results
 * against, not a heuristic guess. Returns null when there's no profit data
 * to derive a ceiling from at all (never fabricates a value).
 */
function deriveGradeMaxAcquisitionPrice(row: GradeProfileRow): number | null {
  if (row.raw_market_value === null) return null;
  const profits = [row.reference_psa7_profit, row.reference_psa8_profit, row.reference_psa9_profit, row.reference_psa10_profit].filter(
    (p): p is number => p !== null,
  );
  if (profits.length === 0) return null;
  return row.raw_market_value + Math.max(...profits);
}

export interface MarketSummaryStats {
  cardsIndexed: number;
  cardsWithMarketData: number;
  /** Cards with a computed flip_profile and/or grade_profile row, whether
   *  or not that profile is eligible — i.e. "we ran the numbers on this
   *  card", distinct from cardsWithMarketData ("we have a price snapshot")
   *  and from the eligible counts below ("it cleared the bar"). */
  cardsProfiled: number;
  dynamicGradeCandidates: number;
  dynamicFlipMarkets: number;
  ebayListingsScanned: number;
  liveOpportunities: number;
}

/** Backs the dashboard's summary header — always computed live from the
 *  current tables, never cached/estimated. */
export async function loadMarketSummaryStats(db: Db): Promise<MarketSummaryStats> {
  const [cardsIndexed, cardsWithMarketData, cardsProfiled, dynamicGradeCandidates, dynamicFlipMarkets, ebayListingsScanned, liveOpportunities] =
    await Promise.all([
      countOf(db, `SELECT COUNT(*) as n FROM cards`),
      countOf(db, `SELECT COUNT(DISTINCT card_id) as n FROM market_snapshots`),
      countOf(
        db,
        `SELECT COUNT(*) as n FROM (
           SELECT card_id FROM flip_profiles
           UNION
           SELECT card_id FROM grade_profiles
         )`,
      ),
      countOf(db, `SELECT COUNT(*) as n FROM grade_profiles WHERE eligible = 1`),
      countOf(db, `SELECT COUNT(*) as n FROM flip_profiles WHERE eligible = 1`),
      countOf(db, `SELECT COUNT(*) as n FROM ebay_listings`),
      countOf(
        db,
        // QUALIFIED_STATES (packages/core/src/opportunity/states.ts) is the
        // single source of truth for "this is an actionable opportunity" —
        // QUALIFIED_FLIP, QUALIFIED_GRADE, INSPECT_PHOTOS. This query used to
        // hardcode 'HIGH_CONFIDENCE_FLIP' and 'GRADE_CANDIDATE', state names
        // from before the 2026-08-31 opportunity-states rebuild that no
        // longer exist anywhere in the schema — so this KPI silently always
        // returned 0, regardless of how many opportunities actually
        // qualified. Found 2026-09-02: a real scan persisted 304 rows but
        // the dashboard still reported "0 live opportunities clearing
        // filters".
        `SELECT COUNT(*) as n FROM opportunities WHERE state IN (${QUALIFIED_STATES.map((s) => `'${s}'`).join(", ")})`,
      ),
    ]);

  return { cardsIndexed, cardsWithMarketData, cardsProfiled, dynamicGradeCandidates, dynamicFlipMarkets, ebayListingsScanned, liveOpportunities };
}

async function countOf(db: Db, sql: string): Promise<number> {
  const row = await db.queryFirst<{ n: number }>(sql);
  return row?.n ?? 0;
}

/** Matches packages/core/src/market/prioritization.ts's STALENESS_CAP_HOURS
 *  — "searched recently" here means within the same one-week window that
 *  ranking treats as maximally fresh, so this stat and the rotation
 *  behaviour it describes stay consistent with each other. */
const STALENESS_CAP_HOURS = 24 * 7;

export interface ScanCoverageStats {
  /** Cards eligible for FLIP and/or GRADE — the Dynamic Flip/Grade Universe
   *  that prioritised eBay search draws from (see listEligibleUniverseCards). */
  eligibleUniverseSize: number;
  /** Eligible cards that have NEVER had an eBay search run for them. */
  neverSearched: number;
  /** Eligible cards last searched within STALENESS_CAP_HOURS (one week). */
  searchedRecently: number;
  /** Of the eligible cards that HAVE been searched at least once, the age
   *  (in hours) of the single oldest last-search — null if none have. */
  oldestSearchedAgeHours: number | null;
}

/**
 * STABILISATION item 3 (coverage/scanning transparency): the Dynamic
 * Flip/Grade Universe (eligible cards) is what prioritised eBay search
 * draws from, but nothing previously reported how much of it is actually
 * being kept fresh versus how much has never been searched, or gone stale.
 * Independent of any specific scan run — always the current live state —
 * so it's meaningful even between scans.
 */
export async function loadScanCoverageStats(db: Db): Promise<ScanCoverageStats> {
  const row = await db.queryFirst<{
    eligibleUniverseSize: number;
    neverSearched: number;
    searchedRecently: number;
    oldestSearchedAgeHours: number | null;
  }>(
    `WITH eligible AS (
       SELECT card_id FROM flip_profiles WHERE eligible = 1
       UNION
       SELECT card_id FROM grade_profiles WHERE eligible = 1
     )
     SELECT
       COUNT(*) as eligibleUniverseSize,
       SUM(CASE WHEN c.last_ebay_scanned_at IS NULL THEN 1 ELSE 0 END) as neverSearched,
       SUM(CASE WHEN c.last_ebay_scanned_at IS NOT NULL
                 AND (julianday('now') - julianday(c.last_ebay_scanned_at)) * 24 <= ?
                THEN 1 ELSE 0 END) as searchedRecently,
       MAX(CASE WHEN c.last_ebay_scanned_at IS NOT NULL
                THEN (julianday('now') - julianday(c.last_ebay_scanned_at)) * 24 END) as oldestSearchedAgeHours
     FROM eligible e
     JOIN cards c ON c.id = e.card_id`,
    STALENESS_CAP_HOURS,
  );

  return {
    eligibleUniverseSize: row?.eligibleUniverseSize ?? 0,
    neverSearched: row?.neverSearched ?? 0,
    searchedRecently: row?.searchedRecently ?? 0,
    oldestSearchedAgeHours: row?.oldestSearchedAgeHours ?? null,
  };
}
