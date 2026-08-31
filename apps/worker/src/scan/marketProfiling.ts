import { Db, type CardRow } from "@mwmc/db";
import { computeFlipProfile, computeGradeProfile } from "@mwmc/core";
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

      snapshotByCardId.set(cardRow.id, toMarketSnapshotLike(snapshot));
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

export function toMarketSnapshotLike(snapshot: MarketSnapshotResult): MarketSnapshotLike {
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
  };
}
