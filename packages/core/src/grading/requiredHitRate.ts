import { round4 } from "../calc/fees.js";

/**
 * REQUIRED HIT RATE — the honest alternative to a fabricated expected value.
 *
 * We do not know this specific physical card's true probability of grading
 * PSA 10. Nobody does before it's graded. So this engine never displays an
 * "expected grading profit" that silently multiplies a made-up probability
 * by an upside — that number would look authoritative and mean nothing.
 *
 * Instead we invert the question. Given the ACTUAL net profit at each
 * grade, we ask:
 *
 *     "How often would this need to come back a PSA 10 just to break even,
 *      assuming every card that isn't a 10 comes back at <fallback grade>?"
 *
 * That is a fact about the economics, not a prediction. The user can then
 * apply their own judgement about whether the card clears that bar.
 *
 *     required p  such that  p * psa10Profit + (1 - p) * fallbackProfit = 0
 *     =>  p = -fallbackProfit / (psa10Profit - fallbackProfit)
 *
 * Worked example (the shape that makes asymmetric plays legible):
 *     PSA9 profit  = -£50
 *     PSA10 profit = +£950
 *     required rate = 50 / 1000 = 5%
 * i.e. one PSA 10 in twenty pays for the other nineteen coming back 9s.
 *
 * This is a REQUIRED rate, never an EXPECTED one. Once our own submission
 * history exists, empirical selection rates can be compared against these
 * thresholds — but that is a separate, later, evidence-backed feature.
 */

export interface RequiredHitRateResult {
  /** Required PSA10 rate to break even, 0..1. Null when not computable. */
  requiredRate: number | null;
  /** Set when the fallback grade is already profitable — no 10s needed. */
  alreadyProfitableAtFallback: boolean;
  /** Set when even a 100% PSA10 rate can't break even. */
  impossible: boolean;
  explanation: string;
}

export function computeRequiredPsa10HitRate(params: {
  /** Net profit if the card comes back at the fallback grade (PSA9 or PSA8). */
  fallbackProfit: number | null;
  /** Net profit if the card comes back PSA10. */
  psa10Profit: number | null;
  /** Label used in the explanation text, e.g. "PSA 9". */
  fallbackLabel: string;
}): RequiredHitRateResult {
  const { fallbackProfit, psa10Profit, fallbackLabel } = params;

  if (fallbackProfit === null || psa10Profit === null) {
    return {
      requiredRate: null,
      alreadyProfitableAtFallback: false,
      impossible: false,
      explanation: `Not computable — missing ${fallbackProfit === null ? fallbackLabel : "PSA 10"} market data.`,
    };
  }

  if (fallbackProfit >= 0) {
    return {
      requiredRate: 0,
      alreadyProfitableAtFallback: true,
      impossible: false,
      explanation: `No PSA 10s required — this already breaks even at ${fallbackLabel}.`,
    };
  }

  // fallbackProfit < 0 from here.
  if (psa10Profit <= 0) {
    return {
      requiredRate: null,
      alreadyProfitableAtFallback: false,
      impossible: true,
      explanation: `Cannot break even at any PSA 10 rate — a PSA 10 loses money too.`,
    };
  }

  const requiredRate = round4(-fallbackProfit / (psa10Profit - fallbackProfit));

  return {
    requiredRate,
    alreadyProfitableAtFallback: false,
    impossible: false,
    explanation: `Requires ${(requiredRate * 100).toFixed(1)}% of these to come back PSA 10 to break even, if every other one grades ${fallbackLabel}. This is a REQUIRED rate, not a predicted one.`,
  };
}
