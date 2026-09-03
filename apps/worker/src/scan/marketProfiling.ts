import { Db, chunkForSqlIn, type CardRow, type MarketSnapshotRow } from "@mwmc/db";
import { computeFlipProfile, computeGradeProfile, extractConditionTierPrices } from "@mwmc/core";
import type { MarketSnapshotLike, ProfileSnapshotInput } from "@mwmc/core";
import type { MarketDataProvider, MarketSnapshotCache, MarketSnapshotResult } from "@mwmc/providers";
import { findExternalRefForCard } from "../repo/externalCardRefsRepo.js";
import { selectCardsNeedingProfileRefresh, upsertFlipProfile, upsertGradeProfile } from "../repo/marketProfilesRepo.js";
import { usdPerGbpFrom, type ResolvedSettings } from "../repo/settingsRepo.js";

/**
 * The CARD MARKET layer of the pipeline (ARCHITECTURE.md): computes Dynamic
 * Flip/Grade Universe membership across catalogued cards, from market data
 * alone — BEFORE any eBay search. Extracted out of scanRunner.ts (rather
 * than living only inline in the full scan) so it can also be driven on
 * its own by `POST /catalogue/sync-and-profile` (apps/worker/src/routes/catalogue.ts)
 * for a bounded, eBay-free validation run against real provider data.
 */
export interface MarketProfilingResult {
  cardsConsidered: number;
  cardsProfiled: number;
  /** Catalogued but no external_card_refs mapping yet for this provider —
   *  distinct from cardsMissingSnapshot so a diagnostic run can tell "we
   *  don't know where to look" apart from "we looked and the provider had
   *  nothing". */
  cardsMissingExternalRef: number;
  cardsMissingSnapshot: number;
  snapshotsFetched: number;
  snapshotByCardId: Map<string, MarketSnapshotLike>;
  /** The CardRow for every card actually profiled this call — lets a
   *  caller (scanRunner.ts) reuse these rows instead of re-querying D1 for
   *  ones it already has in hand. */
  profiledCardRows: CardRow[];
  errors: string[];
}

export async function runMarketProfiling(
  db: Db,
  marketProvider: MarketDataProvider,
  marketCache: MarketSnapshotCache,
  settings: ResolvedSettings,
  maxCards: number,
  staleHours: number,
): Promise<MarketProfilingResult> {
  const errors: string[] = [];
  const snapshotByCardId = new Map<string, MarketSnapshotLike>();
  const profiledCardRows: CardRow[] = [];
  let snapshotsFetched = 0;
  let cardsProfiled = 0;
  let cardsMissingExternalRef = 0;
  let cardsMissingSnapshot = 0;

  const cardsDueForProfiling = await selectCardsNeedingProfileRefresh(db, maxCards, staleHours);

  for (const cardRow of cardsDueForProfiling) {
    try {
      const ref = await findExternalRefForCard(db, marketProvider.name, cardRow.id, settings.externalRefMarketPreference);
      if (!ref) {
        cardsMissingExternalRef++; // catalogued but no market-provider mapping yet — nothing to profile against
        continue;
      }

      const snapshot = await marketCache.getSnapshot(cardRow.id, ref.provider_card_id);
      if (!snapshot) {
        cardsMissingSnapshot++;
        continue;
      }
      snapshotsFetched++;

      const profileInput = toProfileSnapshotInput(snapshot);
      const flipProfile = computeFlipProfile(
        profileInput,
        settings.qualification.flip,
        settings.marketProfileSettings,
        settings.feeModel,
        settings.sellingCosts,
        settings.qsvSettings,
        settings.flipScoreWeights,
      );
      const gradeProfile = computeGradeProfile(
        profileInput,
        settings.marketProfileSettings,
        settings.gradingServices,
        settings.gradingBatch,
        settings.gradingConsumables,
        settings.feeModel,
        settings.sellingCosts,
        settings.classificationSettings,
        usdPerGbpFrom(settings.fxRates),
        settings.gradeScoreWeights,
      );

      await upsertFlipProfile(db, cardRow.id, null, snapshot.sampleSize, flipProfile);
      await upsertGradeProfile(db, cardRow.id, null, snapshot.sampleSize, gradeProfile);

      snapshotByCardId.set(cardRow.id, toMarketSnapshotLike(snapshot, settings.fxRates));
      profiledCardRows.push(cardRow);
      cardsProfiled++;
    } catch (err) {
      errors.push(`Market profiling failed for card ${cardRow.id}: ${String(err)}`);
    }
  }

  return {
    cardsConsidered: cardsDueForProfiling.length,
    cardsProfiled,
    cardsMissingExternalRef,
    cardsMissingSnapshot,
    snapshotsFetched,
    snapshotByCardId,
    profiledCardRows,
    errors,
  };
}

function toProfileSnapshotInput(snapshot: MarketSnapshotResult): ProfileSnapshotInput {
  return {
    rawMarketPrice: snapshot.rawMarketPrice,
    rawMedian7d: snapshot.rawMedian7d,
    rawMedian30d: snapshot.rawMedian30d,
    rawQsv: snapshot.rawQsv,
    psa6: snapshot.psa6 ?? null,
    psa7: snapshot.psa7,
    psa8: snapshot.psa8,
    psa9: snapshot.psa9,
    psa10: snapshot.psa10,
    confidence: snapshot.confidence,
    liquidity: snapshot.liquidity,
    sampleSize: snapshot.sampleSize,
  };
}

export function toMarketSnapshotLike(
  snapshot: MarketSnapshotResult,
  fxRates?: Parameters<typeof extractConditionTierPrices>[1],
): MarketSnapshotLike {
  return {
    sourceProvider: snapshot.sourceProvider,
    priceTimestamp: snapshot.priceTimestamp,
    rawMarketPrice: snapshot.rawMarketPrice,
    rawMedian7d: snapshot.rawMedian7d,
    rawMedian30d: snapshot.rawMedian30d,
    rawQsv: snapshot.rawQsv,
    psa6: snapshot.psa6 ?? null,
    psa7: snapshot.psa7,
    psa8: snapshot.psa8,
    psa9: snapshot.psa9,
    psa10: snapshot.psa10,
    confidence: snapshot.confidence,
    liquidity: snapshot.liquidity,
    sampleSize: snapshot.sampleSize,
    historicalGemRate: snapshot.historicalGemRate,
    // AI INTELLIGENCE item 7: extracted from the SAME raw payload the
    // provider already fetched this run — no extra network call. See
    // conditionTiers.ts's own doc comment for why this is a read-time
    // extraction rather than a persisted column.
    conditionTierPrices: fxRates ? extractConditionTierPrices(snapshot.rawPayload, fxRates) : extractConditionTierPrices(snapshot.rawPayload),
  };
}

/**
 * STABILISATION item 4 (fixes a real false-NO_MARKET_DATA bug): hydrates
 * the latest STORED (D1) market snapshot for a set of cards, independent
 * of whether they were (re)profiled THIS run.
 *
 * Root cause this closes: runMarketProfiling()'s `snapshotByCardId` only
 * covers the budget-capped subset of cards actually profiled THIS run
 * (`selectCardsNeedingProfileRefresh`, capped at MAX_CARDS_PROFILED_PER_RUN
 * in scanRunner.ts) — but the eBay-search step separately selects cards
 * from the FULL eligible universe (`rankForEbaySearch`), which is usually
 * larger. A card searched on eBay this run that wasn't also one of the
 * cards profiled this run got no snapshot entry AT ALL, even when a
 * perfectly valid snapshot already existed in `market_snapshots` from an
 * earlier run — the opportunity engine then had no choice but to mark it
 * NO_MARKET_DATA, even though real market data was available the whole
 * time.
 *
 * Callers should prefer any current-run snapshot first (fresher) and only
 * call this for the cards missing from that map — see scanRunner.ts, which
 * merges this in as a fallback, never an override. A stored row where
 * every price field is null is treated as no snapshot at all — resurrecting
 * an empty row would just move the same bug one layer down.
 */
export async function hydrateStoredSnapshots(
  db: Db,
  cardIds: string[],
  fxRates?: Parameters<typeof extractConditionTierPrices>[1],
): Promise<Map<string, MarketSnapshotLike>> {
  const result = new Map<string, MarketSnapshotLike>();
  if (cardIds.length === 0) return result;

  // 2026-09-03 fix: was one unbounded `IN (?,?,?...)` for the whole array —
  // the same shape of bug that broke getAlreadyEnrichedListingIds live
  // (listingsRepo.ts) once a universe scan passed enough card ids. See
  // sqlChunk.ts's doc comment.
  const rows: MarketSnapshotRow[] = [];
  for (const chunk of chunkForSqlIn(cardIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const chunkRows = await db.queryAll<MarketSnapshotRow>(
      `SELECT ms.* FROM market_snapshots ms
       WHERE ms.card_id IN (${placeholders})
         AND ms.captured_at = (
           SELECT MAX(ms2.captured_at) FROM market_snapshots ms2 WHERE ms2.card_id = ms.card_id
         )`,
      ...chunk,
    );
    rows.push(...chunkRows);
  }

  for (const row of rows) {
    if (row.raw_market_price === null && row.psa7 === null && row.psa8 === null && row.psa9 === null && row.psa10 === null) {
      continue; // no usable price data — not a "valid" snapshot to fall back to
    }
    let rawPayload: unknown;
    try {
      rawPayload = row.raw_payload ? JSON.parse(row.raw_payload) : undefined;
    } catch {
      rawPayload = undefined; // corrupt/legacy row — extractConditionTierPrices treats this as "no data", never fabricates
    }

    result.set(row.card_id, {
      sourceProvider: row.source_provider,
      priceTimestamp: row.price_timestamp,
      rawMarketPrice: row.raw_market_price,
      rawMedian7d: row.raw_median_7d,
      rawMedian30d: row.raw_median_30d,
      rawQsv: row.raw_qsv,
      psa6: row.psa6,
      psa7: row.psa7,
      psa8: row.psa8,
      psa9: row.psa9,
      psa10: row.psa10,
      confidence: row.confidence,
      liquidity: row.liquidity,
      sampleSize: row.sample_size,
      historicalGemRate: row.historical_gem_rate,
      conditionTierPrices: fxRates ? extractConditionTierPrices(rawPayload, fxRates) : extractConditionTierPrices(rawPayload),
    });
  }

  return result;
}
