import { LIQUIDITY_ORDER, type LiquidityLevel, type PsaGrade } from "../calc/types.js";
import type { EconomicClass } from "../grading/classification.js";
import type {
  FlipQualificationRules,
  GradeQualificationRules,
  QualificationFailure,
  QualificationResult,
} from "./types.js";

/**
 * QUALIFICATION — does this opportunity clear the economic bar, yes or no.
 *
 * This is the ONLY place that decides whether something is an opportunity.
 * Score is computed separately and never consulted here: a candidate with a
 * modest score that meets a defined economic structure still qualifies, and
 * a high score never rescues one that doesn't.
 *
 * Failures are returned in full rather than short-circuiting, so the
 * dashboard can show exactly which bar a near-miss failed and by how much —
 * that's what makes the thresholds tunable from evidence instead of feel.
 */

export interface FlipQualificationInput {
  netProfit: number;
  returnOnCapital: number;
  totalAcquisitionCost: number;
  qsv: number | null;
  liquidity: LiquidityLevel;
  confidence: number;
  expectedDaysToSale: number | null;
  /** FALSE when QSV came from a fallback reference rather than a sold median. */
  isHighConfidenceQsv: boolean;
}

export function qualifyFlip(
  input: FlipQualificationInput,
  rules: FlipQualificationRules,
): QualificationResult {
  const failures: QualificationFailure[] = [];
  const passed: string[] = [];

  check(
    input.netProfit >= rules.minNetProfit,
    "minNetProfit",
    `True net profit £${input.netProfit.toFixed(2)} < required £${rules.minNetProfit.toFixed(2)}`,
    `True net profit £${input.netProfit.toFixed(2)}`,
    failures,
    passed,
  );

  check(
    input.returnOnCapital >= rules.minReturnOnCapital,
    "minReturnOnCapital",
    `ROC ${(input.returnOnCapital * 100).toFixed(1)}% < required ${(rules.minReturnOnCapital * 100).toFixed(1)}%`,
    `ROC ${(input.returnOnCapital * 100).toFixed(1)}%`,
    failures,
    passed,
  );

  check(
    input.totalAcquisitionCost <= rules.maxAcquisitionCost,
    "maxAcquisitionCost",
    `Acquisition £${input.totalAcquisitionCost.toFixed(2)} > max £${rules.maxAcquisitionCost.toFixed(2)}`,
    `Acquisition £${input.totalAcquisitionCost.toFixed(2)} within cap`,
    failures,
    passed,
  );

  check(
    (input.qsv ?? 0) >= rules.minQsv,
    "minQsv",
    `QSV £${(input.qsv ?? 0).toFixed(2)} < required £${rules.minQsv.toFixed(2)}`,
    `QSV £${(input.qsv ?? 0).toFixed(2)}`,
    failures,
    passed,
  );

  check(
    LIQUIDITY_ORDER[input.liquidity] >= LIQUIDITY_ORDER[rules.minLiquidity],
    "minLiquidity",
    `Liquidity ${input.liquidity} below required ${rules.minLiquidity}`,
    `Liquidity ${input.liquidity}`,
    failures,
    passed,
  );

  check(
    input.confidence >= rules.minConfidence,
    "minConfidence",
    `Data confidence ${input.confidence.toFixed(2)} < required ${rules.minConfidence.toFixed(2)}`,
    `Data confidence ${input.confidence.toFixed(2)}`,
    failures,
    passed,
  );

  check(
    (input.expectedDaysToSale ?? Infinity) <= rules.maxExpectedDaysToSale,
    "maxExpectedDaysToSale",
    `Expected ${input.expectedDaysToSale ?? "unknown"} days to sale > max ${rules.maxExpectedDaysToSale}`,
    `Expected ${input.expectedDaysToSale} days to sale`,
    failures,
    passed,
  );

  // A flip priced off a fallback reference rather than sold medians is not
  // an executable valuation — it can be watched, never qualified.
  check(
    input.isHighConfidenceQsv,
    "qsvBasis",
    "QSV came from a fallback market reference, not sold medians — not an executable sale value.",
    "QSV derived from sold medians",
    failures,
    passed,
  );

  return { qualifies: failures.length === 0, failures, passed };
}

export interface GradeQualificationInput {
  economicClass: EconomicClass;
  rawAcquisitionCost: number;
  totalGradedBasis: number;
  psa10Value: number | null;
  psa10Profit: number | null;
  psa10GrossMultiple: number | null;
  psa9Profit: number | null;
  psa8Profit: number | null;
  psa7Profit: number | null;
  psa6Profit: number | null;
  /** Sales behind the grade being bought on. null = not known, never zero. */
  salesBehindBuyGrade: number | null;
  breakEvenGrade: PsaGrade | null;
  requiredPsa10RateVsPsa9: number | null;
  liquidity: LiquidityLevel;
  confidence: number;
  estimatedCapitalLockDays: number;
  graderId: string;
  serviceId: string;
}

export function qualifyGrade(
  input: GradeQualificationInput,
  rules: GradeQualificationRules,
): QualificationResult {
  const failures: QualificationFailure[] = [];
  const passed: string[] = [];

  // The economic STRUCTURE is the primary gate. Everything else is a
  // guardrail on top of a structure that already makes sense.
  check(
    rules.enabledEconomicClasses.includes(input.economicClass),
    "economicClass",
    `Economic class ${input.economicClass} is not in the enabled set (${rules.enabledEconomicClasses.join(", ") || "none"})`,
    `Economic class ${input.economicClass}`,
    failures,
    passed,
  );

  check(
    rules.enabledGraderIds.includes(input.graderId),
    "grader",
    `Grader ${input.graderId} is not enabled for arbitrage`,
    `Grader ${input.graderId}`,
    failures,
    passed,
  );

  check(
    rules.enabledServiceIds.includes(input.serviceId),
    "gradingService",
    `Service ${input.serviceId} is not enabled`,
    `Service ${input.serviceId}`,
    failures,
    passed,
  );

  check(
    input.rawAcquisitionCost <= rules.maxRawAcquisitionCost,
    "maxRawAcquisitionCost",
    `Raw acquisition £${input.rawAcquisitionCost.toFixed(2)} > max £${rules.maxRawAcquisitionCost.toFixed(2)}`,
    `Raw acquisition £${input.rawAcquisitionCost.toFixed(2)} within cap`,
    failures,
    passed,
  );

  // Null means no cap, and the check is then ABSENT rather than passing.
  // Recording "within cap" against a cap nobody set would put a rule in the
  // qualification report that was never applied.
  if (rules.maxTotalGradedBasis !== null) {
    check(
      input.totalGradedBasis <= rules.maxTotalGradedBasis,
      "maxTotalGradedBasis",
      `Graded basis £${input.totalGradedBasis.toFixed(2)} > max £${rules.maxTotalGradedBasis.toFixed(2)}`,
      `Graded basis £${input.totalGradedBasis.toFixed(2)} within cap`,
      failures,
      passed,
    );
  }

  check(
    (input.psa10Value ?? 0) >= rules.minPsa10Value,
    "minPsa10Value",
    `PSA 10 slab value £${(input.psa10Value ?? 0).toFixed(2)} < required £${rules.minPsa10Value.toFixed(2)}`,
    `PSA 10 slab value £${(input.psa10Value ?? 0).toFixed(2)}`,
    failures,
    passed,
  );

  check(
    (input.psa10Profit ?? -Infinity) >= rules.minPsa10Profit,
    "minPsa10Profit",
    `PSA 10 profit £${(input.psa10Profit ?? 0).toFixed(2)} < required £${rules.minPsa10Profit.toFixed(2)}`,
    `PSA 10 profit £${(input.psa10Profit ?? 0).toFixed(2)}`,
    failures,
    passed,
  );

  check(
    (input.psa10GrossMultiple ?? 0) >= rules.minPsa10GrossMultiple,
    "minPsa10GrossMultiple",
    `PSA 10 multiple ${(input.psa10GrossMultiple ?? 0).toFixed(2)}x < required ${rules.minPsa10GrossMultiple}x`,
    `PSA 10 multiple ${(input.psa10GrossMultiple ?? 0).toFixed(2)}x`,
    failures,
    passed,
  );

  if (Number.isFinite(rules.minPsa9Profit)) {
    check(
      (input.psa9Profit ?? -Infinity) >= rules.minPsa9Profit,
      "minPsa9Profit",
      `PSA 9 profit £${(input.psa9Profit ?? 0).toFixed(2)} < required £${rules.minPsa9Profit.toFixed(2)}`,
      `PSA 9 profit £${(input.psa9Profit ?? 0).toFixed(2)}`,
      failures,
      passed,
    );
  }

  if (rules.maxPsa8LossPctOfBasis < 1 && input.psa8Profit !== null) {
    const floor = -Math.abs(input.totalGradedBasis * rules.maxPsa8LossPctOfBasis);
    check(
      input.psa8Profit >= floor,
      "maxPsa8LossPctOfBasis",
      `PSA 8 profit £${input.psa8Profit.toFixed(2)} below floor £${floor.toFixed(2)}`,
      `PSA 8 profit £${input.psa8Profit.toFixed(2)} within floor`,
      failures,
      passed,
    );
  }

  /*
   * THE LOW-GRADE FLOORS — the rules the operator's actual strategy needs.
   *
   * Deliberately placed before the PSA 10 guardrails below: if the trade is
   * supposed to pay at a 6, whether it also pays at a 10 is upside, not the
   * thesis. Each is off by default (-Infinity) so nothing changes for anyone
   * who has not set one.
   */
  if (Number.isFinite(rules.minPsa6Profit)) {
    check(
      (input.psa6Profit ?? -Infinity) >= rules.minPsa6Profit,
      "minPsa6Profit",
      input.psa6Profit === null
        ? `No PSA 6 price, so a PSA 6 profit floor of £${rules.minPsa6Profit.toFixed(2)} cannot be met.`
        : `PSA 6 profit £${input.psa6Profit.toFixed(2)} < required £${rules.minPsa6Profit.toFixed(2)}`,
      `PSA 6 profit £${(input.psa6Profit ?? 0).toFixed(2)}`,
      failures,
      passed,
    );
  }

  if (Number.isFinite(rules.minPsa7Profit)) {
    check(
      (input.psa7Profit ?? -Infinity) >= rules.minPsa7Profit,
      "minPsa7Profit",
      input.psa7Profit === null
        ? `No PSA 7 price, so a PSA 7 profit floor of £${rules.minPsa7Profit.toFixed(2)} cannot be met.`
        : `PSA 7 profit £${input.psa7Profit.toFixed(2)} < required £${rules.minPsa7Profit.toFixed(2)}`,
      `PSA 7 profit £${(input.psa7Profit ?? 0).toFixed(2)}`,
      failures,
      passed,
    );
  }

  /*
   * EVIDENCE BEHIND THE GRADE BEING BOUGHT ON.
   *
   * `null` PASSES. A snapshot written before migration 0027 carries no sale
   * counts at all, and treating "not known" as "zero sales" would disqualify
   * the entire existing database in one deploy. Absent evidence is not
   * evidence of absence — it is a reason to go and look, which is what the
   * UI says on the row.
   */
  if (rules.minSalesBehindBuyGrade > 0 && input.salesBehindBuyGrade !== null) {
    check(
      input.salesBehindBuyGrade >= rules.minSalesBehindBuyGrade,
      "minSalesBehindBuyGrade",
      `Only ${input.salesBehindBuyGrade} recorded sale${input.salesBehindBuyGrade === 1 ? "" : "s"} behind the PSA ${rules.buyGrade} price — below the ${rules.minSalesBehindBuyGrade} required. That price is an extrapolation, not a market.`,
      `${input.salesBehindBuyGrade} sales behind the PSA ${rules.buyGrade} price`,
      failures,
      passed,
    );
  }

  if (rules.maxBreakEvenGrade !== null) {
    check(
      input.breakEvenGrade !== null && input.breakEvenGrade <= rules.maxBreakEvenGrade,
      "maxBreakEvenGrade",
      `Break-even grade ${input.breakEvenGrade ?? "NONE"} worse than max PSA ${rules.maxBreakEvenGrade}`,
      `Break-even at PSA ${input.breakEvenGrade}`,
      failures,
      passed,
    );
  }

  if (rules.maxRequiredPsa10Rate < 1) {
    const rate = input.requiredPsa10RateVsPsa9;
    check(
      rate !== null && rate <= rules.maxRequiredPsa10Rate,
      "maxRequiredPsa10Rate",
      `Required PSA 10 rate ${rate === null ? "not computable" : `${(rate * 100).toFixed(1)}%`} > max ${(rules.maxRequiredPsa10Rate * 100).toFixed(1)}%`,
      `Required PSA 10 rate ${rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`}`,
      failures,
      passed,
    );
  }

  check(
    LIQUIDITY_ORDER[input.liquidity] >= LIQUIDITY_ORDER[rules.minLiquidity],
    "minLiquidity",
    `Slab liquidity ${input.liquidity} below required ${rules.minLiquidity}`,
    `Slab liquidity ${input.liquidity}`,
    failures,
    passed,
  );

  check(
    input.confidence >= rules.minConfidence,
    "minConfidence",
    `Data confidence ${input.confidence.toFixed(2)} < required ${rules.minConfidence.toFixed(2)}`,
    `Data confidence ${input.confidence.toFixed(2)}`,
    failures,
    passed,
  );

  check(
    input.estimatedCapitalLockDays <= rules.maxEstimatedCapitalLockDays,
    "maxEstimatedCapitalLockDays",
    `Estimated capital lock ${input.estimatedCapitalLockDays} days > max ${rules.maxEstimatedCapitalLockDays}`,
    `Estimated capital lock ${input.estimatedCapitalLockDays} days`,
    failures,
    passed,
  );

  return { qualifies: failures.length === 0, failures, passed };
}

function check(
  condition: boolean,
  rule: string,
  failureReason: string,
  passDescription: string,
  failures: QualificationFailure[],
  passed: string[],
): void {
  if (condition) passed.push(passDescription);
  else failures.push({ rule, reason: failureReason });
}
