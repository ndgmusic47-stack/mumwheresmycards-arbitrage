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
}

/**
 * EBAY SCANNING prioritisation (realignment brief): never search eBay
 * blindly across the whole catalogue — rank Dynamic Flip/Grade Universe
 * members by score, potential absolute profit, liquidity, confidence, and
 * how stale the last scan is, then take only the top `budget` — the API
 * quota guard for the eBay step. Pure/deterministic given `now` so it's
 * fully unit-testable.
 */
export function rankForEbaySearch(cards: PrioritizableCard[], budget: number, now: Date = new Date()): PrioritizableCard[] {
  const scored = cards.map((card) => ({ card, rank: rankScore(card, now) }));
  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, Math.max(0, budget)).map((s) => s.card);
}

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
