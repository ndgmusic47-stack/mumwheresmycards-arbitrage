import type { LiquidityLevel } from "../calc/types.js";
import { LIQUIDITY_ORDER } from "../calc/types.js";
import { clamp01, normalizeCapped, round1 } from "./normalize.js";

export interface FlipScoreWeights {
  returnOnCapital: number;
  netProfit: number;
  liquidity: number;
  confidence: number;
  listingQuality: number;
}

/** Matches migration 0005 seed row `flip_score_weights`. Configurable via settings. */
export const DEFAULT_FLIP_SCORE_WEIGHTS: FlipScoreWeights = {
  returnOnCapital: 0.3,
  netProfit: 0.25,
  liquidity: 0.2,
  confidence: 0.15,
  listingQuality: 0.1,
};

/**
 * Normalization caps: the value at which a component of the score reaches
 * its maximum (1.0) contribution. These are v1 defaults and are expected to
 * be tuned as real scan data accumulates — kept as named constants (not
 * magic numbers) so that tuning is a one-line change.
 */
export const FLIP_SCORE_NORMALIZATION = {
  /** ROC of 100%+ maxes out the ROC component. */
  returnOnCapitalCap: 1.0,
  /** Net profit of £200+ maxes out the profit component. */
  netProfitCap: 200,
};

export interface FlipScoreInput {
  returnOnCapital: number; // e.g. 0.35 for 35%
  netProfit: number; // currency units
  liquidity: LiquidityLevel;
  confidence: number; // 0..1
  listingQuality: number; // 0..1 — derived from seller feedback, photo quality, etc.
  weights?: Partial<FlipScoreWeights>;
}

export interface ScoreBreakdown {
  score: number; // 0..100
  components: Record<string, { normalized: number; weight: number; contribution: number }>;
}

/**
 * FLIP SCORE (0-100). Weighted blend of return on capital, absolute net
 * profit, liquidity, pricing/data confidence, and listing/seller quality.
 */
export function computeFlipScore(input: FlipScoreInput): ScoreBreakdown {
  const w = { ...DEFAULT_FLIP_SCORE_WEIGHTS, ...input.weights };
  assertWeightsSumToOne(w, "flip");

  const rocNorm = normalizeCapped(input.returnOnCapital, FLIP_SCORE_NORMALIZATION.returnOnCapitalCap);
  const profitNorm = normalizeCapped(input.netProfit, FLIP_SCORE_NORMALIZATION.netProfitCap);
  const liquidityNorm = LIQUIDITY_ORDER[input.liquidity] / 3;
  const confidenceNorm = clamp01(input.confidence);
  const listingQualityNorm = clamp01(input.listingQuality);

  const components = {
    returnOnCapital: { normalized: rocNorm, weight: w.returnOnCapital, contribution: rocNorm * w.returnOnCapital },
    netProfit: { normalized: profitNorm, weight: w.netProfit, contribution: profitNorm * w.netProfit },
    liquidity: { normalized: liquidityNorm, weight: w.liquidity, contribution: liquidityNorm * w.liquidity },
    confidence: { normalized: confidenceNorm, weight: w.confidence, contribution: confidenceNorm * w.confidence },
    listingQuality: {
      normalized: listingQualityNorm,
      weight: w.listingQuality,
      contribution: listingQualityNorm * w.listingQuality,
    },
  };

  const score = round1(
    Object.values(components).reduce((sum, c) => sum + c.contribution, 0) * 100,
  );

  return { score, components };
}

export function assertWeightsSumToOne(weights: Record<string, number>, label: string, tolerance = 0.01): void {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > tolerance) {
    throw new Error(`${label} score weights must sum to 1 (got ${sum})`);
  }
}
