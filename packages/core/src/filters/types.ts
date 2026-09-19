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
  /**
   * Everything spent per card by the time the slab is back — card, postage,
   * grading fee, batch share. NULL means no cap.
   *
   * Nullable since 2026-09-19, on the operator's instruction ("remove it, I
   * don't need it"). It had defaulted to £1,500 and was a second ceiling
   * sitting behind maxRawAcquisitionCost, which is the one he actually
   * steers with. Null is a real absence and the check is skipped entirely
   * rather than passed vacuously — see predicates.ts, and note that a
   * qualification report listing a cap that was never applied is how a rule
   * comes to look enforced when it isn't.
   */
  maxTotalGradedBasis: number | null;
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
  /**
   * THE LOW-GRADE FLOORS. Added 2026-09-13, and they are the point of this
   * whole rule set now.
   *
   * The strategy this tool exists to serve is "buy at £50, make £300 at a
   * PSA 6" — profit at a grade you can actually expect, not a PSA 10 lottery
   * ticket. Before these, the lowest grade with a profit floor was PSA 9 and
   * it defaulted to negative infinity; PSA 6 and PSA 7 could not be
   * expressed at all, while three separate rules gated on PSA 10.
   *
   * -Infinity = off, matching every other optional floor here.
   */
  minPsa6Profit: number;
  minPsa7Profit: number;
  /**
   * Minimum sales the provider must have behind the grade being bought on.
   * 0 = off.
   *
   * A price with no sales behind it is not a price. This is the gate that
   * would have stopped the Blastoise: a PSA 9 figure the price guide itself
   * marks as an extrapolation, standing on roughly one graded sale a year.
   * A grade whose sale count is simply NOT KNOWN (a snapshot taken before
   * migration 0027) passes — absent evidence is not evidence of absence, and
   * silently disqualifying every pre-existing row would be its own lie.
   */
  minSalesBehindBuyGrade: number;
  /**
   * Which grade the two rules above are read against — the grade the
   * operator intends to make their money at.
   */
  buyGrade: 6 | 7 | 8 | 9;
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
  // No cap. maxRawAcquisitionCost (£1,000) is the ceiling the business
  // actually steers with; this one only ever removed cards behind it.
  maxTotalGradedBasis: null,
  minPsa10Value: 80,
  minPsa10Profit: 0,
  minPsa10GrossMultiple: 0,
  minPsa9Profit: -Infinity,
  maxPsa8LossPctOfBasis: 1,
  maxBreakEvenGrade: null,
  maxRequiredPsa10Rate: 1,
  minPsa6Profit: -Infinity,
  minPsa7Profit: -Infinity,
  minSalesBehindBuyGrade: 0,
  buyGrade: 7,
  // WAS "LOW", which was a tautology: LIQUIDITY_ORDER.LOW is 0, so the check
  // read `0 >= 0` and every snapshot on earth passed it. The FLIP side has
  // required MEDIUM all along. Raising it to MEDIUM makes the control mean
  // what it has always claimed to mean.
  minLiquidity: "MEDIUM",
  minConfidence: 0.5,
  maxEstimatedCapitalLockDays: 400,
  enabledGraderIds: ["PSA"],
  // PSA_VALUE dropped 2026-09-19: PSA lists it as not accepting submissions,
  // so qualifying trades against it was pricing a service that cannot be
  // bought. PSA_STANDARD ($59.99) is the cheapest tier actually available.
  enabledServiceIds: ["PSA_STANDARD", "PSA_REGULAR"],
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
