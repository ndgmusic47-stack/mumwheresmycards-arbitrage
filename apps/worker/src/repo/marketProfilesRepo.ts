import { Db, type CardRow, type FlipProfileRow, type GradeProfileRow } from "@mwmc/db";
import type { FlipProfileResult, GradeProfileResult, PrioritizableCard } from "@mwmc/core";

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
       card_id, market_snapshot_id, raw_market_value, conservative_qsv, raw_sample_size, liquidity, confidence,
       max_profitable_acquisition_price, eligible, flip_market_score, ineligible_reason, computed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(card_id) DO UPDATE SET
       market_snapshot_id = excluded.market_snapshot_id,
       raw_market_value = excluded.raw_market_value,
       conservative_qsv = excluded.conservative_qsv,
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
       break_even_grade, psa10_upside_multiple, liquidity, confidence, eligible, grade_market_score, ineligible_reason, computed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
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
    profile.psa10UpsideMultiple,
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
    });
  }

  for (const row of gradeRows) {
    const existing = merged.get(row.card_id);
    const candidateProfit = row.reference_psa10_profit ?? row.reference_psa9_profit ?? null;
    if (!existing) {
      merged.set(row.card_id, {
        cardId: row.card_id,
        score: row.grade_market_score,
        potentialProfit: candidateProfit,
        liquidity: row.liquidity,
        confidence: row.confidence,
        lastEbayScannedAt: row.last_ebay_scanned_at,
      });
    } else {
      existing.score = Math.max(existing.score ?? 0, row.grade_market_score ?? 0);
      existing.potentialProfit = Math.max(existing.potentialProfit ?? 0, candidateProfit ?? 0);
    }
  }

  return merged;
}

export interface MarketSummaryStats {
  cardsIndexed: number;
  cardsWithMarketData: number;
  dynamicGradeCandidates: number;
  dynamicFlipMarkets: number;
  ebayListingsScanned: number;
  liveOpportunities: number;
}

/** Backs the dashboard's summary header — always computed live from the
 *  current tables, never cached/estimated. */
export async function loadMarketSummaryStats(db: Db): Promise<MarketSummaryStats> {
  const [cardsIndexed, cardsWithMarketData, dynamicGradeCandidates, dynamicFlipMarkets, ebayListingsScanned, liveOpportunities] =
    await Promise.all([
      countOf(db, `SELECT COUNT(*) as n FROM cards`),
      countOf(db, `SELECT COUNT(DISTINCT card_id) as n FROM market_snapshots`),
      countOf(db, `SELECT COUNT(*) as n FROM grade_profiles WHERE eligible = 1`),
      countOf(db, `SELECT COUNT(*) as n FROM flip_profiles WHERE eligible = 1`),
      countOf(db, `SELECT COUNT(*) as n FROM ebay_listings`),
      countOf(
        db,
        `SELECT COUNT(*) as n FROM opportunities WHERE state IN ('HIGH_CONFIDENCE_FLIP', 'GRADE_CANDIDATE')`,
      ),
    ]);

  return { cardsIndexed, cardsWithMarketData, dynamicGradeCandidates, dynamicFlipMarkets, ebayListingsScanned, liveOpportunities };
}

async function countOf(db: Db, sql: string): Promise<number> {
  const row = await db.queryFirst<{ n: number }>(sql);
  return row?.n ?? 0;
}
