import type { LiquidityLevel } from "../calc/types.js";
import { LIQUIDITY_ORDER } from "../calc/types.js";
import { clamp01, normalizeRange, normalizeCapped, round1 } from "./normalize.js";
import { assertWeightsSumToOne } from "./flipScore.js";
import type { ScoreBreakdown } from "./flipScore.js";

export interface GradeScoreWeights {
  downsideProtection: number;
  psa9Economics: number;
  psa10Upside: number;
  acquisitionEconomics: number;
  slabLiquidity: number;
  dataConfidence: number;
}

/** Matches migration 0005 seed row `grade_score_weights`. Configurable via settings. */
export const DEFAULT_GRADE_SCORE_WEIGHTS: GradeScoreWeights = {
  downsideProtection: 0.25,
  psa9Economics: 0.2,
  psa10Upside: 0.2,
  acquisitionEconomics: 0.15,
  slabLiquidity: 0.1,
  dataConfidence: 0.1,
};

export const GRADE_SCORE_NORMALIZATION = {
  /** Worst-case ROC range mapped to the downside-protection component: -100%..+50%. */
  downsideRocMin: -1.0,
  downsideRocMax: 0.5,
  /** PSA 9 ROC of 150%+ maxes out the PSA9 economics component. */
  psa9RocCap: 1.5,
  /** PSA10 net-proceeds-to-basis multiple of 4x+ maxes out the upside component. */
  psa10MultipleCap: 4.0,
  /** Raw market price / purchase price "bargain ratio" of 2x+ maxes acquisition economics. */
  bargainRatioCap: 2.0,
};

export interface GradeScoreInput {
  /** ROC at the worst *populated* grade rung (typically PSA 6 or 7) — downside case. */
  worstCaseReturnOnCapital: number;
  /** ROC at PSA 9 specifically (the modal outcome for most well-centered modern cards). */
  psa9ReturnOnCapital: number;
  /** PSA10 net proceeds / total graded basis. */
  psa10UpsideMultiple: number;
  /** raw market price / raw purchase price — how good a bargain the raw buy is. */
  bargainRatio: number;
  slabLiquidity: LiquidityLevel;
  dataConfidence: number; // 0..1
  weights?: Partial<GradeScoreWeights>;
}

/**
 * GRADE SCORE (0-100). Weighted blend of downside protection, PSA9
 * economics, PSA10 upside, acquisition economics, slab liquidity, and data
 * confidence. Deliberately does NOT use historical gem rate as a
 * probability weight — see packages/core/src/opportunity for why.
 */
export function computeGradeScore(input: GradeScoreInput): ScoreBreakdown {
  const w = { ...DEFAULT_GRADE_SCORE_WEIGHTS, ...input.weights };
  assertWeightsSumToOne(w, "grade");

  const downsideNorm = normalizeRange(
    input.worstCaseReturnOnCapital,
    GRADE_SCORE_NORMALIZATION.downsideRocMin,
    GRADE_SCORE_NORMALIZATION.downsideRocMax,
  );
  const psa9Norm = normalizeCapped(input.psa9ReturnOnCapital, GRADE_SCORE_NORMALIZATION.psa9RocCap);
  const psa10Norm = normalizeCapped(input.psa10UpsideMultiple, GRADE_SCORE_NORMALIZATION.psa10MultipleCap);
  const bargainNorm = normalizeCapped(input.bargainRatio, GRADE_SCORE_NORMALIZATION.bargainRatioCap);
  const slabLiquidityNorm = LIQUIDITY_ORDER[input.slabLiquidity] / 3;
  const confidenceNorm = clamp01(input.dataConfidence);

  const components = {
    downsideProtection: {
      normalized: downsideNorm,
      weight: w.downsideProtection,
      contribution: downsideNorm * w.downsideProtection,
    },
    psa9Economics: { normalized: psa9Norm, weight: w.psa9Economics, contribution: psa9Norm * w.psa9Economics },
    psa10Upside: { normalized: psa10Norm, weight: w.psa10Upside, contribution: psa10Norm * w.psa10Upside },
    acquisitionEconomics: {
      normalized: bargainNorm,
      weight: w.acquisitionEconomics,
      contribution: bargainNorm * w.acquisitionEconomics,
    },
    slabLiquidity: {
      normalized: slabLiquidityNorm,
      weight: w.slabLiquidity,
      contribution: slabLiquidityNorm * w.slabLiquidity,
    },
    dataConfidence: {
      normalized: confidenceNorm,
      weight: w.dataConfidence,
      contribution: confidenceNorm * w.dataConfidence,
    },
  };

  const score = round1(Object.values(components).reduce((sum, c) => sum + c.contribution, 0) * 100);

  return { score, components };
}
