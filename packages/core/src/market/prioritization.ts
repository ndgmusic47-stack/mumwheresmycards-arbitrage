import type { LiquidityLevel } from "../calc/types.js";
import { LIQUIDITY_ORDER } from "../calc/types.js";
import { clamp01 } from "../scoring/normalize.js";

export interface PrioritizableCard {
  cardId: string;
  /** flip_market_score or grade_market_score for this universe member. */
  score: number | null;
  /** Absolute £ reference profit figure (e.g. from the profile), used so a
   *  £5,000 card and a £20 card with the same score don't rank equally. */
  potentialProfit: number | null;
  liquidity: LiquidityLevel;
  confidence: number;
  /** ISO timestamp of the last time we searched eBay for this card, or null if never. */
  lastEbayScannedAt: string | null;
  /**
   * STABILISATION item 11 ("use max acquisition price to avoid returning
   * obviously overpriced inventory where safe"): the highest total
   * acquisition cost (item price + shipping) at which this card could ever
   * qualify under EITHER strategy it's eligible for, derived from the
   * market-profile layer (see marketProfilesRepo.ts's listEligibleUniverseCards
   * for how this is computed) — a hard economic ceiling, not a heuristic.
   * null means no safe ceiling could be derived (e.g. no grade profit data
   * yet), in which case the eBay search step must NOT apply a price filter
   * for this card. This field only ever feeds an eBay search-query price
   * filter — it plays no part in ranking, which is why it isn't part of
   * rankScore() below.
   */
  maxAcquisitionPrice: number | null;
}

/**
 * EBAY SCANNING prioritisation (realignment brief): never search eBay
 * blindly across the whole catalogue — rank Dynamic Flip/Grade Universe
 * members by score, potential absolute profit, liquidity, confidence, and
 * how stale the last scan is, then take only the top `budget` — the API
 * quota guard for the eBay step. Pure/deterministic given `now` so it's
 * fully unit-testable.
 *
 * STABILISATION item 3 (rotation guarantee): the weighted blend alone is
 * NOT sufficient to guarantee every eligible card is eventually searched.
 * The staleness term only accounts for 15% of the score, so a small subset
 * of cards that stays permanently strong on score/profit/liquidity/
 * confidence can rank above every other card on every single run, even
 * cards that have NEVER been searched — resetting `lastEbayScannedAt`
 * after a scan only costs that subset the staleness term, which isn't
 * enough to fall behind a maximally-stale but otherwise average card. Left
 * alone, that's a genuine permanent-starvation bug for the rest of the
 * eligible universe, not just a low-priority ordering choice.
 *
 * To close that without touching the weighted blend itself (which is a
 * commercial ranking decision, not a bug), a fixed slice of the budget is
 * reserved for whichever eligible cards have gone longest without a
 * search, regardless of how they rank normally. This guarantees every
 * eligible card is searched at least once within roughly
 * ceil(universe size / reserved slots per run) runs, independent of score
 * — see packages/core/test/prioritization.test.ts for a simulated
 * multi-run regression test proving this against an adversarial
 * permanently-dominant subset.
 */
export function rankForEbaySearch(
  cards: PrioritizableCard[],
  budget: number,
  now: Date = new Date(),
  staleReserveFraction: number = STALE_RESERVE_FRACTION,
): PrioritizableCard[] {
  const effectiveBudget = Math.max(0, budget);
  if (effectiveBudget === 0 || cards.length === 0) return [];

  const scored = cards.map((card) => ({ card, rank: rankScore(card, now) }));
  scored.sort((a, b) => b.rank - a.rank);

  // Budget covers the whole universe this run — no rotation guarantee is
  // even needed, everything gets searched regardless of order.
  if (cards.length <= effectiveBudget) {
    return scored.map((s) => s.card);
  }

  const staleReserve = Math.max(1, Math.round(effectiveBudget * staleReserveFraction));
  const normalSlots = Math.max(0, effectiveBudget - staleReserve);

  const picked = scored.slice(0, normalSlots).map((s) => s.card);
  const pickedIds = new Set(picked.map((c) => c.cardId));

  const remaining = scored
    .filter((s) => !pickedIds.has(s.card.cardId))
    .sort((a, b) => staleness(b.card.lastEbayScannedAt, now) - staleness(a.card.lastEbayScannedAt, now));

  for (const s of remaining.slice(0, effectiveBudget - picked.length)) {
    picked.push(s.card);
  }

  return picked;
}

/** Fraction of each run's budget reserved for the most-stale eligible
 *  cards, independent of their normal rank — the rotation guarantee
 *  above. 20% of a 100-card budget is 20 guaranteed-stale slots per run. */
const STALE_RESERVE_FRACTION = 0.2;

/** Equal-weighted v1 blend — see ARCHITECTURE.md for making this
 *  configurable alongside FLIP/GRADE score weights. */
const WEIGHTS = { score: 0.35, profit: 0.25, liquidity: 0.15, confidence: 0.1, staleness: 0.15 };

/** £500+ reference profit maxes out the profit component. */
const PROFIT_CAP = 500;

/** A full week stale maxes out the staleness component. */
const STALENESS_CAP_HOURS = 24 * 7;

function rankScore(card: PrioritizableCard, now: Date): number {
  const scoreNorm = clamp01((card.score ?? 0) / 100);
  const profitNorm = clamp01((card.potentialProfit ?? 0) / PROFIT_CAP);
  const liquidityNorm = LIQUIDITY_ORDER[card.liquidity] / 3;
  const confidenceNorm = clamp01(card.confidence);
  const stalenessNorm = staleness(card.lastEbayScannedAt, now);

  return (
    scoreNorm * WEIGHTS.score +
    profitNorm * WEIGHTS.profit +
    liquidityNorm * WEIGHTS.liquidity +
    confidenceNorm * WEIGHTS.confidence +
    stalenessNorm * WEIGHTS.staleness
  );
}

function staleness(lastScannedAt: string | null, now: Date): number {
  if (!lastScannedAt) return 1; // never scanned => maximum priority
  const ageHours = (now.getTime() - new Date(lastScannedAt).getTime()) / (1000 * 60 * 60);
  return clamp01(ageHours / STALENESS_CAP_HOURS);
}
