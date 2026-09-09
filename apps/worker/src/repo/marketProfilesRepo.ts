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
export async function selectCardsNeedingProfileRefresh(
  db: Db,
  limit: number,
  staleHours: number,
  ineligibleStaleHours: number = staleHours,
): Promise<CardRow[]> {
  return db.queryAll<CardRow>(
    `SELECT c.* FROM cards c
     LEFT JOIN flip_profiles fp ON fp.card_id = c.id
     LEFT JOIN grade_profiles gp ON gp.card_id = c.id
     WHERE ${PROFILE_DUE_CONDITION}
     ORDER BY ${PROFILE_PRIORITY_ORDER}
     LIMIT ?`,
    staleHours,
    ineligibleStaleHours,
    limit,
  );
}

/**
 * Shared by the selector and the backlog counter so the two can never
 * disagree about what "due" means (the dashboard's before/after backlog
 * figures are only trustworthy if they count exactly what the next run will
 * pick from). Binds `staleHours` then `ineligibleStaleHours`, in that order.
 *
 * Tiered 2026-09-08 — see MarketProviderBudgetSettings.ineligibleRefreshHours
 * for why a single flat window made the backlog undrainable at real
 * catalogue size.
 */
const PROFILE_DUE_CONDITION = `(
  fp.card_id IS NULL
  OR fp.computed_at < datetime('now', '-' || (CASE WHEN fp.eligible = 1 OR gp.eligible = 1 THEN ? ELSE ? END) || ' hours')
)`;

/**
 * 1. Eligible cards that have gone stale — these ARE the live opportunity
 *    universe, so letting them rot while the crawler grinds through 70,000
 *    never-priced commons would be exactly backwards.
 * 2. Never-priced cards — every one of these is a card we cannot have an
 *    opinion about at all until it gets a first price.
 * 3. Everything else, oldest first.
 */
const PROFILE_PRIORITY_ORDER = `
  CASE
    WHEN fp.eligible = 1 OR gp.eligible = 1 THEN 0
    WHEN fp.card_id IS NULL THEN 1
    ELSE 2
  END ASC,
  fp.computed_at ASC`;

/**
 * How many cards `selectCardsNeedingProfileRefresh` would still consider
 * due right now — i.e. the profiling BACKLOG. Same WHERE clause as the
 * selector above, deliberately, so this number and what the next run picks
 * from can never disagree. Surfaced on every scan result so the backlog
 * visibly shrinks run over run (at 200 cards/run every 30 minutes, ~62,000
 * unprofiled cards is ~6.5 days of runs — a number the user needs to be
 * able to WATCH move, not take on faith). Fixed 2026-09-08.
 */
export async function countCardsAwaitingProfile(
  db: Db,
  staleHours: number,
  ineligibleStaleHours: number = staleHours,
): Promise<number> {
  const row = await db.queryFirst<{ n: number }>(
    `SELECT COUNT(*) as n FROM cards c
     LEFT JOIN flip_profiles fp ON fp.card_id = c.id
     LEFT JOIN grade_profiles gp ON gp.card_id = c.id
     WHERE ${PROFILE_DUE_CONDITION}`,
    staleHours,
    ineligibleStaleHours,
  );
  return row?.n ?? 0;
}

/**
 * Prefix on `flip_profiles.ineligible_reason` marking a row that is NOT a
 * computed profile at all, just a record that the card was CHECKED and the
 * market provider had nothing for it (or we had no provider id to ask
 * with). Fixed 2026-09-08 — closes a genuinely expensive live bug:
 *
 * `selectCardsNeedingProfileRefresh` puts never-profiled cards first, and
 * a card the provider returned nothing for never got a flip_profiles row,
 * so it stayed "never profiled" and came straight back to the FRONT of the
 * queue every single run. With the catalogue at ~76k cards, the same ~200
 * empty cards were re-requested from PokeTrace every 30 minutes, forever —
 * thousands of wasted quota calls a day, zero new price snapshots, and
 * ~62k cards that never got reached at all. Writing this marker row gives
 * the card a `computed_at`, so it rotates to the BACK for `staleHours`
 * (the same TTL a real profile gets) and is re-checked after that — which
 * also means a card that later gains an external ref, or whose provider
 * data appears later, self-heals on the next pass rather than being
 * written off permanently.
 *
 * Only flip_profiles gets the marker (it's the table the queue is keyed
 * on); grade_profiles is left untouched. `eligible` is 0, every economics
 * column is null, so nothing downstream can mistake it for a real profile —
 * and `loadMarketSummaryStats`'s "cards profiled" KPI explicitly excludes
 * rows carrying this prefix, so a checked-but-empty card never inflates
 * "we ran the numbers on this card".
 */
export const NOT_PROFILED_MARKER_PREFIX = "NOT_PROFILED:";

export type NotProfiledReason = "PROVIDER_NO_DATA" | "NO_EXTERNAL_REF";

const NOT_PROFILED_REASON_TEXT: Record<NotProfiledReason, string> = {
  PROVIDER_NO_DATA: `${NOT_PROFILED_MARKER_PREFIX} market provider had no price data for this card at last check`,
  NO_EXTERNAL_REF: `${NOT_PROFILED_MARKER_PREFIX} no market-provider card reference to look this card up with`,
};

export async function markCardCheckedWithoutData(db: Db, cardId: string, reason: NotProfiledReason): Promise<void> {
  await db.exec(
    `INSERT INTO flip_profiles (card_id, eligible, ineligible_reason, computed_at)
     VALUES (?, 0, ?, datetime('now'))
     ON CONFLICT(card_id) DO UPDATE SET
       market_snapshot_id = NULL,
       raw_market_value = NULL,
       conservative_qsv = NULL,
       qsv_basis = NULL,
       is_high_confidence_qsv = NULL,
       raw_sample_size = NULL,
       max_profitable_acquisition_price = NULL,
       discovery_max_acquisition_price = NULL,
       eligible = 0,
       flip_market_score = NULL,
       ineligible_reason = excluded.ineligible_reason,
       computed_at = datetime('now')
     WHERE flip_profiles.eligible = 0`,
    // The WHERE guard: never let a "checked, nothing there" marker overwrite
    // a card that currently holds a real ELIGIBLE profile. In practice this
    // path can't reach such a card (an eligible profile implies a stored
    // snapshot, and cache.ts falls back to that stored row rather than
    // returning null), but a marker clobbering a live universe member would
    // be a worse bug than the one this fixes, so it's guarded structurally.
    cardId,
    NOT_PROFILED_REASON_TEXT[reason],
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
       max_profitable_acquisition_price, discovery_max_acquisition_price, eligible, flip_market_score, ineligible_reason, computed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
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
       discovery_max_acquisition_price = excluded.discovery_max_acquisition_price,
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
    profile.discoveryMaxAcquisitionPrice,
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
      // MWMC V1 FINAL SHIP PASS item 4/6/7: the eBay search ceiling must be
      // the BROAD break-even bound, not the persisted qualification bar's
      // ceiling (max_profitable_acquisition_price) — see flipProfile.ts's
      // discoveryMaxAcquisitionPrice doc comment for why. Falls back to
      // max_profitable_acquisition_price only for a row computed before this
      // column existed (pre-migration-0023 data, until the next re-profile
      // refreshes it) so old rows don't regress to "no ceiling at all".
      maxAcquisitionPrice: row.discovery_max_acquisition_price ?? row.max_profitable_acquisition_price,
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
        // A NOT_PROFILED marker row (see markCardCheckedWithoutData) is a
        // record that we LOOKED, not that we ran any numbers — exclude it
        // here or the "cards profiled" KPI would climb by ~200 per run
        // while the provider keeps saying "nothing for this card".
        `SELECT COUNT(*) as n FROM (
           SELECT card_id FROM flip_profiles
            WHERE ineligible_reason IS NULL OR ineligible_reason NOT LIKE '${NOT_PROFILED_MARKER_PREFIX}%'
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
