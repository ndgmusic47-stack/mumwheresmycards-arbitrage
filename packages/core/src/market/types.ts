import type { LiquidityLevel, PsaGrade } from "../calc/types.js";
import type { EconomicClass } from "../grading/classification.js";
import type { QsvBasis } from "./qsv.js";

/**
 * Structural snapshot shape the profiling functions need — matches
 * MarketSnapshotLike (packages/core/src/opportunity) field-for-field
 * without importing it, so this module stays independently usable and
 * testable.
 */
export interface ProfileSnapshotInput {
  rawMarketPrice: number | null;
  /** 7-day SOLD median. Never an asking price. */
  rawMedian7d?: number | null;
  /** 30-day SOLD median. Never an asking price. */
  rawMedian30d?: number | null;
  rawQsv: number | null;
  psa6?: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  confidence: number;
  liquidity: LiquidityLevel;
  sampleSize: number | null;
}

/**
 * Thresholds deciding whether a catalogued card enters the Dynamic Flip /
 * Grade Universe at all — a coarse, cheap pre-filter over the WHOLE
 * catalogue, run before any eBay search.
 *
 * This layer is deliberately LOOSER than the per-listing qualification
 * rules (packages/core/src/filters). Its only job is "could this card ever
 * be worth spending an eBay API call on?", so it must not encode the
 * profit bar — a card can easily be uninteresting at its own market price
 * and highly profitable at an underpriced listing, which is the entire
 * premise of the business.
 */
export interface MarketProfileSettings {
  minFlipRawValue: number;
  minFlipLiquidity: LiquidityLevel;
  minFlipConfidence: number;
  minGradeRawValue: number;
  minGradeConfidence: number;
  /**
   * Economic classes worth searching eBay for at the catalogue level.
   * Includes ASYMMETRIC by default — excluding it here would silently
   * discard every high-upside candidate before a listing is ever seen,
   * which is exactly the "arbitrary PSA10-only rejection" this model is
   * meant to avoid.
   */
  eligibleEconomicClasses: EconomicClass[];
}

export const DEFAULT_MARKET_PROFILE_SETTINGS: MarketProfileSettings = {
  minFlipRawValue: 5,
  minFlipLiquidity: "LOW",
  minFlipConfidence: 0.4,
  minGradeRawValue: 5,
  minGradeConfidence: 0.4,
  eligibleEconomicClasses: ["DOWNSIDE_PROTECTED", "BALANCED", "ASYMMETRIC"],
};

export interface FlipProfileResult {
  eligible: boolean;
  ineligibleReason: string | null;
  rawMarketValue: number | null;
  /** QSV from sold medians, less the quick-sale haircut. */
  conservativeQsv: number | null;
  qsvBasis: QsvBasis;
  isHighConfidenceQsv: boolean;
  liquidity: LiquidityLevel;
  confidence: number;
  /**
   * Highest all-in acquisition cost that would still clear the flip
   * qualification bar (£ profit AND ROC) against this card's QSV. This is
   * the number the eBay-search step uses to decide which asking prices are
   * worth looking at — NOT a forecast for a real trade.
   */
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
  /**
   * Total graded basis computed using the card's OWN raw market value as a
   * REFERENCE acquisition price — for ranking/filtering the catalogue only.
   * A real trade always recomputes this from the actual listing price.
   */
  referenceGradedBasis: number | null;
  referenceProfitByGrade: Partial<Record<PsaGrade, number | null>>;
  breakEvenGrade: PsaGrade | null;
  psa10GrossMultiple: number | null;
  economicClass: EconomicClass;
  economicClassRationale: string | null;
  requiredPsa10RateVsPsa9: number | null;
  /** Service used for the reference basis — echoed so the UI can say which. */
  referenceServiceId: string | null;
  estimatedCapitalLockDays: number | null;
  liquidity: LiquidityLevel;
  confidence: number;
  gradeMarketScore: number | null;
}
