import type { LiquidityLevel, PsaGrade } from "../calc/types.js";

export type StrategyFilter = "FLIP" | "GRADE" | "BOTH";

export interface GlobalFilters {
  strategy: StrategyFilter;
  minNetProfit: number;
  minReturnOnCapital: number; // fraction, e.g. 0.35
  minProfitMargin: number; // fraction
  maxAcquisitionPrice: number;
  minLiquidity: LiquidityLevel;
  minConfidence: number; // 0..1
}

export interface FlipFilters {
  minQsv: number;
  maxDaysToSale: number;
}

export interface GradeFilters {
  minPsa10Value: number;
  minPsa10UpsideMultiple: number;
  minAcceptableBreakEvenGrade: PsaGrade;
  safeZoneOnly: boolean;
  maxGradedBasis: number;
}

export interface FilterSet {
  global: GlobalFilters;
  flip: FlipFilters;
  grade: GradeFilters;
}

/** Minimal shape a candidate opportunity must expose to be filterable. Kept
 * decoupled from the DB row / engine Opportunity type so filters stay pure
 * and independently testable. */
export interface FilterableOpportunity {
  strategy: "FLIP" | "GRADE";
  netProfit: number;
  returnOnCapital: number;
  profitMargin: number;
  acquisitionPrice: number;
  liquidity: LiquidityLevel;
  confidence: number;
  // FLIP-only
  qsv?: number;
  daysToSaleEstimate?: number;
  // GRADE-only
  psa10Value?: number | null;
  psa10UpsideMultiple?: number | null;
  breakEvenGrade?: PsaGrade | null;
  gradedBasis?: number;
}

export interface FilterFailure {
  filter: string;
  reason: string;
}

export interface FilterEvaluation {
  passes: boolean;
  failures: FilterFailure[];
}
