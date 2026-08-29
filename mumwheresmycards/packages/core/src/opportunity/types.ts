import type { RawCardIdentity } from "../card/types.js";
import type { LiquidityLevel, PsaGrade } from "../calc/types.js";
import type { FlipScoreWeights } from "../scoring/flipScore.js";
import type { GradeScoreWeights } from "../scoring/gradeScore.js";
import type { FilterSet } from "../filters/types.js";
import type { OpportunityState } from "./states.js";

/**
 * Engine-level input shape for a live listing. Deliberately structural
 * (not imported from @mwmc/providers) so packages/core has ZERO dependency
 * on packages/providers — the dependency direction is providers -> core,
 * never the reverse. apps/worker maps a provider's RawEbayListing into
 * this shape before calling the engine.
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

/** Engine-level input shape for a market snapshot — structurally matches
 *  MarketSnapshotResult from @mwmc/providers without importing it. */
export interface MarketSnapshotLike {
  sourceProvider: string;
  priceTimestamp: string;
  rawMarketPrice: number | null;
  rawQsv: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  confidence: number;
  liquidity: LiquidityLevel;
  sampleSize: number | null;
  historicalGemRate?: number | null;
}

export interface OpportunityEngineSettings {
  filters: FilterSet;
  flipScoreWeights?: Partial<FlipScoreWeights>;
  gradeScoreWeights?: Partial<GradeScoreWeights>;
  /** FLIP SCORE at/above this is a HIGH_CONFIDENCE_FLIP once filters pass. */
  highConfidenceFlipScoreThreshold?: number;
  /** GRADE SCORE at/above this is a GRADE_CANDIDATE once filters pass. */
  gradeCandidateScoreThreshold?: number;
  /** Resolver confidence below this => REJECTED_CARD_IDENTITY_UNCERTAIN. */
  identityRejectConfidenceThreshold?: number;
  /** Resolver confidence below this (but above reject) => INSPECT_PHOTOS. */
  identityInspectConfidenceThreshold?: number;
}

export interface OpportunityCandidate {
  listingId: string;
  cardPrintingHash: string | null;
  strategy: "FLIP" | "GRADE";
  state: OpportunityState;
  flipScore: number | null;
  gradeScore: number | null;
  listingPrice: number;
  totalAcquisitionCost: number;
  liquidity: LiquidityLevel | null;
  confidence: number;

  // FLIP
  qsv?: number | null;
  expectedNetSaleProceeds?: number | null;
  expectedNetProfit?: number | null;
  returnOnCapital?: number | null;
  profitMargin?: number | null;
  daysToSaleEstimate?: number | null;

  // GRADE
  totalGradedBasis?: number | null;
  psa6Profit?: number | null;
  psa7Profit?: number | null;
  psa8Profit?: number | null;
  psa9Profit?: number | null;
  psa10Profit?: number | null;
  breakEvenGrade?: PsaGrade | null;
  psa10UpsideMultiple?: number | null;

  reasoning: string[];
}
