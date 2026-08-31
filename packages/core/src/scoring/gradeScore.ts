import type { LiquidityLevel } from "../calc/types.js";
import { LIQUIDITY_ORDER } from "../calc/types.js";
import { clamp01, normalizeCapped, round1 } from "./normalize.js";
import { assertWeightsSumToOne } from "./flipScore.js";
import type { ScoreBreakdown } from "./flipScore.js";
import type { EconomicClass } from "../grading/classification.js";

export interface GradeScoreWeights {
  downsideProtection: number;
  psa9Economics: number;
  psa10Upside: number;
  requiredHitRate: number;
  slabLiquidity: number;
  capitalVelocity: number;
  dataConfidence: number;
}

/** Configurable via settings (`grade_score_weights`). */
export const DEFAULT_GRADE_SCORE_WEIGHTS: GradeScoreWeights = {
  downsideProtection: 0.25,
  psa9Economics: 0.2,
  psa10Upside: 0.15,
  requiredHitRate: 0.15,
  slabLiquidity: 0.1,
  capitalVelocity: 0.1,
  dataConfidence: 0.05,
};

export const GRADE_SCORE_NORMALIZATION = {
  /** PSA9 ROC of 150%+ maxes out the PSA9 economics component. */
  psa9RocCap: 1.5,
  /** PSA10 gross multiple of 8x+ maxes out the upside component. */
  psa10MultipleCap: 8.0,
  /** A required PSA10 rate at or below this scores full marks. */
  requiredRateExcellent: 0.05,
  /** A required PSA10 rate at or above this scores zero. */
  requiredRatePoor: 0.5,
  /** Capital lock at or below this many days scores full marks. */
  capitalLockDaysExcellent: 45,
  /** Capital lock at or above this many days scores zero. */
  capitalLockDaysPoor: 300,
};

/**
 * Scoring credit for each economic structure. DOWNSIDE PROTECTED receives a
 * major advantage by design: a trade whose floor is already covered is
 * categorically more attractive than one that needs a good grade to avoid a
 * loss, and the score should say so loudly.
 */
export const ECONOMIC_CLASS_SCORE: Record<EconomicClass, number> = {
  DOWNSIDE_PROTECTED: 1.0,
  BALANCED: 0.6,
  ASYMMETRIC: 0.35,
  UNCLASSIFIED: 0,
};

export interface GradeScoreInput {
  economicClass: EconomicClass;
  psa7Profit: number | null;
  psa9Profit: number | null;
  psa9ReturnOnCapital: number;
  psa10GrossMultiple: number;
  /** Required PSA10 rate vs the PSA9 fallback. Lower is better. */
  requiredPsa10Rate: number | null;
  gradedBasis: number;
  slabLiquidity: LiquidityLevel;
  dataConfidence: number;
  estimatedCapitalLockDays: number;
  weights?: Partial<GradeScoreWeights>;
}

/**
 * GRADE SCORE (0-100) — RANKING ONLY.
 *
 * This score never decides whether an opportunity qualifies; that is
 * settled entirely by economics in ../filters/predicates.ts before this
 * function is consulted. Its only job is to order the qualifying set so the
 * most attractive structures surface first.
 *
 * Deliberately does NOT use historical gem rate, or any other stand-in for
 * grade probability, as a weight — see ../grading/requiredHitRate.ts.
 */
export function computeGradeScore(input: GradeScoreInput): ScoreBreakdown {
  const w = { ...DEFAULT_GRADE_SCORE_WEIGHTS, ...input.weights };
  assertWeightsSumToOne(w, "grade");

  const downsideNorm = ECONOMIC_CLASS_SCORE[input.economicClass] ?? 0;
  const psa9Norm = normalizeCapped(input.psa9ReturnOnCapital, GRADE_SCORE_NORMALIZATION.psa9RocCap);
  const psa10Norm = normalizeCapped(input.psa10GrossMultiple, GRADE_SCORE_NORMALIZATION.psa10MultipleCap);
  const requiredRateNorm = scoreRequiredRate(input.requiredPsa10Rate);
  const slabLiquidityNorm = LIQUIDITY_ORDER[input.slabLiquidity] / 3;
  const velocityNorm = scoreCapitalLock(input.estimatedCapitalLockDays);
  const confidenceNorm = clamp01(input.dataConfidence);

  const components = {
    downsideProtection: {
      normalized: downsideNorm,
      weight: w.downsideProtection,
      contribution: downsideNorm * w.downsideProtection,
    },
    psa9Economics: { normalized: psa9Norm, weight: w.psa9Economics, contribution: psa9Norm * w.psa9Economics },
    psa10Upside: { normalized: psa10Norm, weight: w.psa10Upside, contribution: psa10Norm * w.psa10Upside },
    requiredHitRate: {
      normalized: requiredRateNorm,
      weight: w.requiredHitRate,
      contribution: requiredRateNorm * w.requiredHitRate,
    },
    slabLiquidity: {
      normalized: slabLiquidityNorm,
      weight: w.slabLiquidity,
      contribution: slabLiquidityNorm * w.slabLiquidity,
    },
    capitalVelocity: {
      normalized: velocityNorm,
      weight: w.capitalVelocity,
      contribution: velocityNorm * w.capitalVelocity,
    },
    dataConfidence: {
      normalized: confidenceNorm,
      weight: w.dataConfidence,
      contribution: confidenceNorm * w.dataConfidence,
    },
  };

  return {
    score: round1(Object.values(components).reduce((sum, c) => sum + c.contribution, 0) * 100),
    components,
  };
}

/** Lower required hit rate is better; already-profitable-at-fallback is best. */
function scoreRequiredRate(rate: number | null): number {
  if (rate === null) return 0;
  const { requiredRateExcellent, requiredRatePoor } = GRADE_SCORE_NORMALIZATION;
  if (rate <= requiredRateExcellent) return 1;
  if (rate >= requiredRatePoor) return 0;
  return clamp01(1 - (rate - requiredRateExcellent) / (requiredRatePoor - requiredRateExcellent));
}

/** Faster capital return is better. */
function scoreCapitalLock(days: number): number {
  const { capitalLockDaysExcellent, capitalLockDaysPoor } = GRADE_SCORE_NORMALIZATION;
  if (days <= capitalLockDaysExcellent) return 1;
  if (days >= capitalLockDaysPoor) return 0;
  return clamp01(1 - (days - capitalLockDaysExcellent) / (capitalLockDaysPoor - capitalLockDaysExcellent));
}
