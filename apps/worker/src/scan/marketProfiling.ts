import { Db, chunkForSqlIn, type CardRow, type MarketSnapshotRow } from "@mwmc/db";
import { computeFlipProfile, computeGradeProfile, extractConditionTierPrices } from "@mwmc/core";
import type { MarketSnapshotLike, ProfileSnapshotInput } from "@mwmc/core";
import { RateLimitExceededError, countProviderCallsToday } from "@mwmc/providers";
import type { MarketDataProvider, MarketSnapshotCache, MarketSnapshotResult } from "@mwmc/providers";
import { findExternalRefForCard } from "../repo/externalCardRefsRepo.js";
import {
  countCardsAwaitingProfile,
  markCardCheckedWithoutData,
  selectCardsNeedingProfileRefresh,
  upsertFlipProfile,
  upsertGradeProfile,
} from "../repo/marketProfilesRepo.js";
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
  /**
   * 2026-09-08 profiling-loop fix — progress + protection, all surfaced so
   * the user can WATCH the backlog drain rather than trust that it is:
   * - cardsAwaitingProfileBefore/After: the queue size before and after this
   *   run (see countCardsAwaitingProfile). After < Before is the proof the
   *   loop is no longer stuck.
   * - cardsMarkedNoData: cards this run recorded a NOT_PROFILED marker for
   *   (provider had nothing / no external ref) — previously these silently
   *   came straight back next run.
   * - stoppedOnRateLimit: the provider said stop and we stopped, leaving the
   *   rest of this run's cards for the next run instead of hammering on.
   * - providerCallsUsedToday / providerDailyBudget / cardsSkippedForBudget:
   *   the daily cap (settings.marketProviderBudget) and what it cost this run.
   */
  cardsAwaitingProfileBefore: number;
  cardsAwaitingProfileAfter: number;
  cardsMarkedNoData: number;
  stoppedOnRateLimit: boolean;
  providerCallsUsedToday: number;
  providerDailyBudget: number;
  cardsSkippedForBudget: number;
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
  let cardsMarkedNoData = 0;
  let stoppedOnRateLimit = false;

  // --- Daily provider budget (settings.marketProviderBudget) -------------
  // Checked once, up front, against real non-cache-hit calls since UTC
  // midnight. The run's card budget shrinks to whatever's left, counting
  // every card as if it WILL cost a call (conservative — cache hits and
  // no-ref cards cost nothing, so the true spend is at or under this).
  const providerDailyBudget = settings.marketProviderBudget.maxProviderCallsPerDay;
  const providerCallsUsedToday = await countProviderCallsToday(db, marketProvider.name);
  const remainingBudget = Math.max(0, providerDailyBudget - providerCallsUsedToday);
  const effectiveMaxCards = Math.min(maxCards, remainingBudget);
  const cardsSkippedForBudget = maxCards - effectiveMaxCards;
  if (cardsSkippedForBudget > 0) {
    errors.push(
      `Market profiling budget: ${providerCallsUsedToday} of ${providerDailyBudget} daily ${marketProvider.name} calls already used today — ` +
        (effectiveMaxCards === 0
          ? "profiling skipped this run; resumes after UTC midnight (or raise settings.market_provider_budget.maxProviderCallsPerDay)."
          : `only ${effectiveMaxCards} of ${maxCards} cards profiled this run.`),
    );
  }

  const cardsAwaitingProfileBefore = await countCardsAwaitingProfile(db, staleHours);
  const cardsDueForProfiling = effectiveMaxCards > 0 ? await selectCardsNeedingProfileRefresh(db, effectiveMaxCards, staleHours) : [];

  for (const cardRow of cardsDueForProfiling) {
    try {
      const ref = await findExternalRefForCard(db, marketProvider.name, cardRow.id, settings.externalRefMarketPreference);
      if (!ref) {
        cardsMissingExternalRef++; // catalogued but no market-provider mapping yet — nothing to profile against
        // Record that we looked, so this card rotates to the back of the
        // queue for `staleHours` instead of blocking the front forever —
        // see markCardCheckedWithoutData's doc comment for the live bug.
        await markCardCheckedWithoutData(db, cardRow.id, "NO_EXTERNAL_REF");
        cardsMarkedNoData++;
        continue;
      }

      const snapshot = await marketCache.getSnapshot(cardRow.id, ref.provider_card_id);
      if (!snapshot) {
        cardsMissingSnapshot++;
        await markCardCheckedWithoutData(db, cardRow.id, "PROVIDER_NO_DATA");
        cardsMarkedNoData++;
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
      if (isRateLimitError(err)) {
        // The provider has said stop (after fetchWithBackoff's own retries
        // already waited it out and gave up). Before 2026-09-08 this fell
        // through to the generic catch below and CONTINUED to the next card
        // — each of which then re-hit the limit, re-waited up to 90s of
        // backoff, and re-failed — burning quota and wall-clock on a
        // provider that had already told us no. Stop the whole step
        // instead: the unprocessed cards keep their place in the queue
        // (no marker written — they weren't checked) and the next run picks
        // them up first.
        stoppedOnRateLimit = true;
        errors.push(
          `Market profiling stopped early: ${marketProvider.name} rate limit hit at card ${cardRow.id} — ` +
            `${cardsProfiled + cardsMarkedNoData} of ${cardsDueForProfiling.length} cards processed this run; the rest stay queued for the next run.`,
        );
        break;
      }
      errors.push(`Market profiling failed for card ${cardRow.id}: ${String(err)}`);
    }
  }

  const cardsAwaitingProfileAfter = await countCardsAwaitingProfile(db, staleHours);

  return {
    cardsConsidered: cardsDueForProfiling.length,
    cardsProfiled,
    cardsMissingExternalRef,
    cardsMissingSnapshot,
    snapshotsFetched,
    cardsAwaitingProfileBefore,
    cardsAwaitingProfileAfter,
    cardsMarkedNoData,
    stoppedOnRateLimit,
    providerCallsUsedToday,
    providerDailyBudget,
    cardsSkippedForBudget,
    snapshotByCardId,
    profiledCardRows,
    errors,
  };
}

/** `instanceof` plus a name check, so the detection still holds if the
 *  providers package ever ends up duplicated in a bundle (vitest module
 *  graphs, in particular, can produce two copies of the same class). */
function isRateLimitError(err: unknown): boolean {
  return err instanceof RateLimitExceededError || (err instanceof Error && err.name === "RateLimitExceededError");
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
