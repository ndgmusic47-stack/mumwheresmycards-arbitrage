import type { LiquidityLevel, PsaGrade } from "../calc/types.js";

/**
 * Structural snapshot shape the profiling functions need — matches
 * MarketSnapshotLike (packages/core/src/opportunity) field-for-field
 * without importing it, so this module stays independently usable and
 * testable. apps/worker maps a persisted market_snapshots row into this
 * shape (already GBP-normalized — see market/currency.ts) before calling
 * computeFlipProfile/computeGradeProfile.
 */
export interface ProfileSnapshotInput {
  rawMarketPrice: number | null;
  rawQsv: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  confidence: number;
  liquidity: LiquidityLevel;
  sampleSize: number | null;
}

/**
 * Thresholds used only to decide whether a catalogued card enters the
 * Dynamic Flip/Grade Universe at all — a coarse, cheap pre-filter over the
 * WHOLE catalogue. This is deliberately looser/separate from the dashboard
 * filter set (packages/core/src/filters), which is applied per real
 * listing once a specific trade is being evaluated. Matches migration 0009
 * seed row `market_profile_settings`.
 */
export interface MarketProfileSettings {
  minFlipRawValue: number;
  minFlipLiquidity: LiquidityLevel;
  minFlipConfidence: number;
  minGradeRawValue: number;
  minGradeConfidence: number;
  /** Cards whose break-even grade is worse than this (or that never break even) are not worth searching eBay for. Null disables this check. */
  maxAcceptableBreakEvenGradeForEligibility: PsaGrade | null;
}

export const DEFAULT_MARKET_PROFILE_SETTINGS: MarketProfileSettings = {
  minFlipRawValue: 5,
  minFlipLiquidity: "LOW",
  minFlipConfidence: 0.4,
  minGradeRawValue: 5,
  minGradeConfidence: 0.4,
  maxAcceptableBreakEvenGradeForEligibility: 10,
};

export interface FlipProfileResult {
  eligible: boolean;
  ineligibleReason: string | null;
  rawMarketValue: number | null;
  conservativeQsv: number | null;
  liquidity: LiquidityLevel;
  confidence: number;
  /** Highest total acquisition cost (all-in) that would still clear the
   *  global minNetProfit AND minReturnOnCapital filters against this card's
   *  QSV. This is the number the eBay-search step uses to decide which
   *  asking prices are even worth looking at — NOT a forecast for a real
   *  trade (that only exists once a real listing is scored). */
  maxProfitableAcquisitionPrice: number | null;
  flipMarketScore: number | null;
}

export interface GradeProfileResult {
  eligible: boolean;
  ineligibleReason: string | null;
  rawMarketValue: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  /** Total graded basis computed using the card's OWN raw market value as a
   *  REFERENCE acquisition price — for ranking/filtering the catalogue
   *  only. A real trade always recomputes this from the actual listing
   *  price (packages/core/src/opportunity). */
  referenceGradedBasis: number | null;
  referenceProfitByGrade: Partial<Record<PsaGrade, number | null>>;
  breakEvenGrade: PsaGrade | null;
  psa10UpsideMultiple: number | null;
  liquidity: LiquidityLevel;
  confidence: number;
  gradeMarketScore: number | null;
}
