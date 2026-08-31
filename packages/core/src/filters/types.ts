import type { LiquidityLevel, PsaGrade } from "../calc/types.js";
import type { EconomicClass } from "../grading/classification.js";

export type StrategyFilter = "FLIP" | "GRADE" | "BOTH";

/**
 * QUALIFICATION RULES — economics, and only economics, decide whether an
 * opportunity qualifies. Score never appears here; see ../scoring for what
 * score is actually for (ranking qualifying opportunities, nothing else).
 *
 * Every field is editable from the dashboard Settings/Filters UI. Changing
 * any of these must never require a code change.
 */

export interface FlipQualificationRules {
  /**
   * TRUE NET PROFIT floor, in £. Deliberately absolute: a £12 profit on a
   * £15 card is an 80% ROC and still not worth the operational overhead of
   * sourcing, storing, listing, packing and shipping it.
   */
  minNetProfit: number;
  /** RETURN ON ACQUISITION CAPITAL floor, as a fraction. 0.40 = 40%. */
  minReturnOnCapital: number;
  maxAcquisitionCost: number;
  minQsv: number;
  minLiquidity: LiquidityLevel;
  minConfidence: number;
  maxExpectedDaysToSale: number;
}

export const DEFAULT_FLIP_QUALIFICATION: FlipQualificationRules = {
  minNetProfit: 40,
  minReturnOnCapital: 0.4,
  maxAcquisitionCost: 500,
  minQsv: 20,
  minLiquidity: "MEDIUM",
  minConfidence: 0.6,
  maxExpectedDaysToSale: 30,
};

export interface GradeQualificationRules {
  /**
   * Which economic structures count as opportunities. An empty list
   * disables grading entirely. ASYMMETRIC is included by default: those are
   * discovery candidates shown with their downside, not auto-buys.
   */
  enabledEconomicClasses: EconomicClass[];
  maxRawAcquisitionCost: number;
  maxTotalGradedBasis: number;
  minPsa10Value: number;
  minPsa10Profit: number;
  minPsa10GrossMultiple: number;
  minPsa9Profit: number;
  /** Max acceptable PSA8 loss as a fraction of graded basis. 0.10 = -10%. */
  maxPsa8LossPctOfBasis: number;
  /** Worst acceptable break-even grade. null = don't require one at all. */
  maxBreakEvenGrade: PsaGrade | null;
  /** Max acceptable REQUIRED PSA10 rate (vs PSA9 fallback). 1 = no ceiling. */
  maxRequiredPsa10Rate: number;
  minLiquidity: LiquidityLevel;
  minConfidence: number;
  maxEstimatedCapitalLockDays: number;
  /** Grader ids eligible for arbitrage, e.g. ["PSA"]. */
  enabledGraderIds: string[];
  /** Service ids eligible, e.g. ["PSA_REGULAR","PSA_VALUE"]. */
  enabledServiceIds: string[];
}

/**
 * Defaults are deliberately permissive on STRUCTURE (all three economic
 * classes enabled) and strict on DATA QUALITY. The point of V1 is to
 * discover real opportunities including asymmetric ones — not to filter the
 * catalogue down to only the safest handful.
 */
export const DEFAULT_GRADE_QUALIFICATION: GradeQualificationRules = {
  enabledEconomicClasses: ["DOWNSIDE_PROTECTED", "BALANCED", "ASYMMETRIC"],
  maxRawAcquisitionCost: 1000,
  maxTotalGradedBasis: 1500,
  minPsa10Value: 80,
  minPsa10Profit: 0,
  minPsa10GrossMultiple: 0,
  minPsa9Profit: -Infinity,
  maxPsa8LossPctOfBasis: 1,
  maxBreakEvenGrade: null,
  maxRequiredPsa10Rate: 1,
  minLiquidity: "LOW",
  minConfidence: 0.5,
  maxEstimatedCapitalLockDays: 400,
  enabledGraderIds: ["PSA"],
  enabledServiceIds: ["PSA_REGULAR", "PSA_VALUE"],
};

export interface QualificationRuleSet {
  strategy: StrategyFilter;
  flip: FlipQualificationRules;
  grade: GradeQualificationRules;
}

export const DEFAULT_QUALIFICATION_RULES: QualificationRuleSet = {
  strategy: "BOTH",
  flip: { ...DEFAULT_FLIP_QUALIFICATION },
  grade: { ...DEFAULT_GRADE_QUALIFICATION },
};

export interface QualificationFailure {
  rule: string;
  reason: string;
}

export interface QualificationResult {
  qualifies: boolean;
  failures: QualificationFailure[];
  /** Everything the candidate DID satisfy — shown so a near-miss is legible. */
  passed: string[];
}
