import type { RawCardIdentity } from "../card/types.js";
import type {
  GradingBatchSettings,
  GradingConsumables,
  GradingService,
  LiquidityLevel,
  PsaGrade,
  SellingCostSettings,
} from "../calc/types.js";
import type { ExitMarketFeeModel } from "../calc/fees.js";
import type { FlipScoreWeights } from "../scoring/flipScore.js";
import type { GradeScoreWeights } from "../scoring/gradeScore.js";
import type { QualificationRuleSet, QualificationFailure } from "../filters/types.js";
import type { ClassificationSettings, EconomicClass } from "../grading/classification.js";
import type { QsvSettings } from "../market/qsv.js";
import type { OpportunityState } from "./states.js";

/**
 * Engine-level input shape for a live listing. Deliberately structural
 * (not imported from @mwmc/providers) so packages/core has ZERO dependency
 * on packages/providers — the dependency direction is providers -> core,
 * never the reverse.
 */
export interface ListingCandidate {
  listingId: string;
  title: string;
  price: number;
  shippingCost: number;
  importTax?: number;
  acquisitionFees?: number;
  itemUrl: string;
  sellerFeedbackScore?: number;
  sellerFeedbackPct?: number;
  imageCount?: number;
  parsedIdentity: RawCardIdentity;
}

/** Engine-level input shape for a market snapshot. */
export interface MarketSnapshotLike {
  sourceProvider: string;
  priceTimestamp: string;
  rawMarketPrice: number | null;
  /** 7-day SOLD median. Never an asking price. */
  rawMedian7d?: number | null;
  /** 30-day SOLD median. Never an asking price. */
  rawMedian30d?: number | null;
  /** Pre-computed QSV from the provider layer, if already derived. */
  rawQsv: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  psa6?: number | null;
  confidence: number;
  liquidity: LiquidityLevel;
  sampleSize: number | null;
  historicalGemRate?: number | null;
}

export interface OpportunityEngineSettings {
  qualification: QualificationRuleSet;
  qsvSettings: QsvSettings;
  feeModel: ExitMarketFeeModel;
  sellingCosts: SellingCostSettings;
  gradingServices: GradingService[];
  gradingBatch: GradingBatchSettings;
  gradingConsumables: GradingConsumables;
  classificationSettings: ClassificationSettings;
  flipScoreWeights?: Partial<FlipScoreWeights>;
  gradeScoreWeights?: Partial<GradeScoreWeights>;
  /** GBP -> USD, for checking slab values against USD declared-value caps. */
  usdPerGbp?: number | null;
  /** Estimated days-to-sale for a RAW card, by liquidity. */
  rawDaysToSale?: Record<LiquidityLevel, number>;
  /** Estimated days-to-sale for a GRADED slab, by liquidity. */
  slabDaysToSale?: Record<LiquidityLevel, number>;
  /** Resolver confidence below this => REJECTED_CARD_IDENTITY_UNCERTAIN. */
  identityRejectConfidenceThreshold?: number;
  /** Resolver confidence below this (but above reject) => INSPECT_PHOTOS. */
  identityInspectConfidenceThreshold?: number;
}

/** Per-grade economics, carried through to the dashboard unmodified. */
export interface GradeRungView {
  grade: PsaGrade;
  grossSlabValue: number | null;
  sellingFees: number | null;
  netProceeds: number | null;
  profit: number | null;
  returnOnCapital: number | null;
  potentialUpcharge: boolean;
}

export interface OpportunityCandidate {
  listingId: string;
  cardPrintingHash: string | null;
  strategy: "FLIP" | "GRADE";
  state: OpportunityState;
  /** 0-100 RANKING score. Never a qualification gate. */
  score: number | null;
  /** TRUE when this cleared the economic bar. Set by ../filters/predicates.ts. */
  qualifies: boolean;
  qualificationFailures: QualificationFailure[];

  listingPrice: number;
  /** Delivered acquisition cost — item + postage + tax + fees. */
  totalAcquisitionCost: number;
  liquidity: LiquidityLevel | null;
  confidence: number;
  identityConfidence: number;

  // ---- FLIP ----
  qsv?: number | null;
  qsvBasis?: string | null;
  isHighConfidenceQsv?: boolean;
  buyerPayment?: number | null;
  sellingFees?: number | null;
  expectedNetSaleProceeds?: number | null;
  expectedNetProfit?: number | null;
  returnOnCapital?: number | null;
  profitMargin?: number | null;
  expectedDaysToSale?: number | null;
  profitPerCapitalDay?: number | null;

  // ---- GRADE ----
  graderId?: string | null;
  gradingServiceId?: string | null;
  gradingServiceName?: string | null;
  totalGradedBasis?: number | null;
  gradeRungs?: GradeRungView[];
  psa6Profit?: number | null;
  psa7Profit?: number | null;
  psa8Profit?: number | null;
  psa9Profit?: number | null;
  psa10Profit?: number | null;
  psa10Value?: number | null;
  breakEvenGrade?: PsaGrade | null;
  psa10GrossMultiple?: number | null;
  economicClass?: EconomicClass | null;
  economicClassRationale?: string | null;
  requiredPsa10RateVsPsa9?: number | null;
  requiredPsa10RateVsPsa8?: number | null;
  estimatedGradingDays?: number | null;
  estimatedCapitalLockDays?: number | null;
  annualisedRocIndicator?: number | null;
  potentialUpcharge?: boolean;
  /** Set when a different enabled service would return capital faster per £. */
  betterVelocityServiceId?: string | null;

  reasoning: string[];
}
