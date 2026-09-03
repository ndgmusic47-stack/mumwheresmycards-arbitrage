import { round2, round4 } from "../calc/fees.js";

/**
 * SOURCING WORKFLOW item 11 (market price-spread display): the gap between
 * the 7-day and 30-day sold medians — a real, already-captured signal
 * (both live on every market_snapshots row, migration 0013) that was
 * computed into QSV (`min(7d, 30d) * 0.92`, see qsv.ts) but never surfaced
 * on its own. The spread is a genuine trend signal a manual sourcer cares
 * about: a card whose 7-day median sits well above its 30-day median is
 * moving up in price recently (the reference this tool prices against may
 * already be stale-favourable); the reverse means recent sales are running
 * BELOW the 30-day trend (the reference may be stale-optimistic).
 *
 * `STABLE_THRESHOLD` (2%) is a deliberate, documented heuristic for "this
 * is noise, not a real trend" — consistent with this codebase's other
 * threshold heuristics (liquidity's sample-size bands, listingQuality's
 * feedback-percentage scaling), not hidden as an unstated assumption.
 */
const STABLE_THRESHOLD = 0.02;

export interface PriceSpreadInput {
  median7d: number | null;
  median30d: number | null;
}

export interface PriceSpreadResult {
  /** median7d - median30d, in currency units. Null when either median is
   *  unavailable or the 30-day median is non-positive (nothing safe to
   *  divide by for the fraction below). */
  delta: number | null;
  /** delta / median30d — signed, so a negative value means the 7-day
   *  median sits BELOW the 30-day one. */
  deltaFraction: number | null;
  direction: "RISING" | "FALLING" | "STABLE" | null;
}

export function computeMedianPriceSpread(input: PriceSpreadInput): PriceSpreadResult {
  if (input.median7d === null || input.median30d === null || input.median30d <= 0) {
    return { delta: null, deltaFraction: null, direction: null };
  }

  const delta = round2(input.median7d - input.median30d);
  const deltaFraction = round4(delta / input.median30d);
  const direction: PriceSpreadResult["direction"] =
    Math.abs(deltaFraction) < STABLE_THRESHOLD ? "STABLE" : deltaFraction > 0 ? "RISING" : "FALLING";

  return { delta, deltaFraction, direction };
}
