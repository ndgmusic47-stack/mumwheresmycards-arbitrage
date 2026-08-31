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

  check(
    input.totalGradedBasis <= rules.maxTotalGradedBasis,
    "maxTotalGradedBasis",
    `Graded basis £${input.totalGradedBasis.toFixed(2)} > max £${rules.maxTotalGradedBasis.toFixed(2)}`,
    `Graded basis £${input.totalGradedBasis.toFixed(2)} within cap`,
    failures,
    passed,
  );

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
