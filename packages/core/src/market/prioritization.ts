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
  /**
   * 2026-09-09 (AUCTION EDGE): ISO timestamp of the soonest still-running
   * auction on this card, or null when it has none.
   *
   * An auction close is a HARD DEADLINE — miss it and the opportunity is
   * gone permanently, unlike a fixed-price listing that will still be there
   * next run. But the scanner rotates ~60 cards per run out of a universe
   * of thousands, so a card's current bid on screen could be hours old at
   * the exact moment the user is deciding whether to bid. That made the
   * "max bid" figure honest but its HEADROOM untrustworthy right when it
   * mattered most.
   *
   * This field is what lets rankForEbaySearch guarantee those cards a slot.
   * It plays no part in rankScore() — it drives a reserve, not a weight,
   * because a deadline is categorical, not a matter of degree.
   */
  soonestActiveAuctionEndsAt: string | null;
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

  // ---- AUCTION EDGE (2026-09-09): closing auctions go first ------------
  //
  // Taken BEFORE the score ranking and before the stale reserve, because
  // this is the one category where being late is unrecoverable. Everything
  // else in this function is about which cards are most worth looking at;
  // this is about which ones will stop existing.
  //
  // A cap, not a quota: `slice` takes only as many as actually qualify, so
  // when nothing is closing the whole budget flows to normal ranking
  // exactly as before.
  const closingCap = Math.max(1, Math.round(effectiveBudget * CLOSING_AUCTION_RESERVE_FRACTION));
  const picked = closingAuctionsFirst(cards, now, CLOSING_AUCTION_WINDOW_HOURS).slice(0, closingCap);
  const pickedIds = new Set(picked.map((c) => c.cardId));

  // Whatever the closing reserve didn't use stays available to everyone else.
  const remainingBudget = effectiveBudget - picked.length;
  const staleReserve = Math.max(1, Math.round(remainingBudget * staleReserveFraction));
  const normalSlots = Math.max(0, remainingBudget - staleReserve);

  // Fill the normal slots from the score ranking, skipping anything the
  // closing reserve already took (a closing auction on a high-scoring card
  // must not consume two slots).
  const normalTarget = picked.length + normalSlots;
  for (const s of scored) {
    if (picked.length >= normalTarget) break;
    if (pickedIds.has(s.card.cardId)) continue;
    picked.push(s.card);
    pickedIds.add(s.card.cardId);
  }

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

/**
 * How far ahead an auction counts as "closing" for the reserve below.
 *
 * Three hours, against a 30-minute cron: a card entering the window is
 * therefore re-searched roughly six times before its auction ends, so the
 * bid on screen is minutes old rather than hours by the time it matters.
 * Wider would spend the reserve on auctions that don't need it yet;
 * narrower risks a card entering and closing between two runs.
 */
export const CLOSING_AUCTION_WINDOW_HOURS = 3;

/**
 * The CAP (not a quota) on how much of a run's eBay budget closing auctions
 * may take. Unused slots fall straight through to normal ranking, so a quiet
 * period costs discovery nothing at all.
 *
 * 40% is deliberately generous. The asymmetry justifies it: a discovery
 * search deferred by thirty minutes loses nothing, while a stale bid at a
 * close either costs a lost auction or an overpayment. When more auctions
 * are closing than slots exist, the soonest win — an auction ending in ten
 * minutes outranks one ending in two hours, every time.
 */
export const CLOSING_AUCTION_RESERVE_FRACTION = 0.4;

/** Cards with a still-running auction inside the window, soonest first.
 *  An end time in the PAST is excluded: that listing is over, and
 *  expireEndedAuctionListings() will mark it ENDED on this same run. */
function closingAuctionsFirst(cards: PrioritizableCard[], now: Date, windowHours: number): PrioritizableCard[] {
  const horizon = now.getTime() + windowHours * 3600_000;
  return cards
    .map((card) => {
      if (!card.soonestActiveAuctionEndsAt) return null;
      const raw = card.soonestActiveAuctionEndsAt;
      const endsAt = new Date(raw.includes("T") || raw.includes("Z") ? raw : `${raw.replace(" ", "T")}Z`).getTime();
      if (Number.isNaN(endsAt) || endsAt <= now.getTime() || endsAt > horizon) return null;
      return { card, endsAt };
    })
    .filter((entry): entry is { card: PrioritizableCard; endsAt: number } => entry !== null)
    .sort((a, b) => a.endsAt - b.endsAt)
    .map((entry) => entry.card);
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
