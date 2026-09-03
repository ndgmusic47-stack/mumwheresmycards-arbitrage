import type {
  GradeLadderResult,
  GradingBatchSettings,
  GradingConsumables,
  GradingService,
  LiquidityLevel,
  PsaGrade,
  SellingCostSettings,
} from "../calc/types.js";
import type { ExitMarketFeeModel } from "../calc/fees.js";
import { round4 } from "../calc/fees.js";
import { profitPerCapitalDay } from "../calc/metricDefinitions.js";
import { computeGradedBasis } from "../calc/gradingBasis.js";
import { computeGradeLadder } from "../calc/gradeLadder.js";
import { classifyGradeEconomics, type ClassificationResult, type ClassificationSettings } from "./classification.js";
import { computeRequiredPsa10HitRate, type RequiredHitRateResult } from "./requiredHitRate.js";

/**
 * PROFIT vs CAPITAL VELOCITY.
 *
 * The cheapest grading service is not automatically the best one. A £23
 * service that locks capital for 160+ business days can easily be worse
 * than a £65 service that returns in 75 — the cheaper tier wins on absolute
 * profit per card while losing badly on profit per day of capital locked,
 * and capital that comes back sooner can be redeployed.
 *
 * So every candidate is evaluated against EVERY enabled service, and both
 * winners are surfaced: best absolute profit, and best capital velocity.
 * They frequently differ, and which one matters depends on whether capital
 * or deal flow is the binding constraint that month — that's a judgement
 * for the operator, so the engine shows both rather than picking.
 *
 * All turnaround figures are ESTIMATES. Graders publish targets, not
 * guarantees, and actual turnaround routinely runs longer.
 */

/** Post-grading listing-to-sale estimate by slab liquidity, in calendar days. */
export const DEFAULT_SLAB_DAYS_TO_SALE: Record<LiquidityLevel, number> = {
  LOW: 60,
  MEDIUM: 30,
  HIGH: 14,
  VERY_HIGH: 7,
};

/** Business days -> calendar days. 5 business days per 7 calendar days. */
export const BUSINESS_DAYS_TO_CALENDAR = 7 / 5;

export interface ServiceEvaluation {
  service: GradingService;
  gradedBasis: number;
  ladder: GradeLadderResult;
  classification: ClassificationResult;
  requiredPsa10RateVsPsa9: RequiredHitRateResult;
  requiredPsa10RateVsPsa8: RequiredHitRateResult;
  /** Estimated grading turnaround in calendar days. */
  estimatedGradingDays: number;
  /** Grading turnaround + estimated post-grade time to sell. */
  estimatedCapitalLockDays: number;
  /** Profit at the reference grade used for velocity comparison (PSA 9). */
  referenceProfit: number | null;
  referenceRoc: number | null;
  /** Reference profit per day of capital lock. */
  profitPerCapitalLockDay: number | null;
  /** ROC scaled to a 365-day year. An INDICATOR, not a forecast return. */
  annualisedRocIndicator: number | null;
  anyPotentialUpcharge: boolean;
}

export interface ServiceComparisonResult {
  evaluations: ServiceEvaluation[];
  /** Highest absolute profit at the reference grade. */
  bestAbsoluteProfit: ServiceEvaluation | null;
  /** Highest profit per day of capital locked. */
  bestCapitalVelocity: ServiceEvaluation | null;
  /** TRUE when those two are different services — worth the operator's attention. */
  bestProfitAndVelocityDiffer: boolean;
}

export interface ServiceComparisonInput {
  rawPurchasePrice: number;
  sellerPostage: number;
  importTax?: number;
  acquisitionFees?: number;
  slabValues: Partial<Record<PsaGrade, number | null>>;
  slabLiquidity: LiquidityLevel;
  services: GradingService[];
  batch: GradingBatchSettings;
  consumables: GradingConsumables;
  feeModel: ExitMarketFeeModel;
  sellingCosts: SellingCostSettings;
  classificationSettings: ClassificationSettings;
  usdPerGbp?: number | null;
  /** Reserve carried into the basis when an upcharge looks likely. */
  upchargeReserve?: number;
  slabDaysToSale?: Record<LiquidityLevel, number>;
}

/** The grade used as the reference outcome when comparing services. */
export const VELOCITY_REFERENCE_GRADE: PsaGrade = 9;

export function compareGradingServices(input: ServiceComparisonInput): ServiceComparisonResult {
  const daysToSaleTable = input.slabDaysToSale ?? DEFAULT_SLAB_DAYS_TO_SALE;
  const enabled = input.services.filter((s) => s.enabled);

  const evaluations: ServiceEvaluation[] = enabled.map((service) => {
    const basis = computeGradedBasis({
      rawPurchasePrice: input.rawPurchasePrice,
      sellerPostage: input.sellerPostage,
      importTax: input.importTax,
      acquisitionFees: input.acquisitionFees,
      service,
      batch: input.batch,
      consumables: input.consumables,
      upchargeReserve: input.upchargeReserve,
    });

    const ladder = computeGradeLadder(
      {
        totalGradedBasis: basis.total,
        slabValues: input.slabValues,
        service,
        usdPerGbp: input.usdPerGbp ?? undefined,
      },
      input.feeModel,
      input.sellingCosts,
    );

    const classification = classifyGradeEconomics(ladder, input.classificationSettings);

    const profitAt = (grade: PsaGrade): number | null =>
      ladder.rungs.find((r) => r.grade === grade)?.profit ?? null;

    const psa8Profit = profitAt(8);
    const psa9Profit = profitAt(9);
    const psa10Profit = profitAt(10);

    const estimatedGradingDays = Math.round(
      service.estimatedTurnaroundBusinessDays * BUSINESS_DAYS_TO_CALENDAR,
    );
    const estimatedCapitalLockDays = estimatedGradingDays + daysToSaleTable[input.slabLiquidity];

    const referenceRung = ladder.rungs.find((r) => r.grade === VELOCITY_REFERENCE_GRADE) ?? null;
    const referenceProfit = referenceRung?.profit ?? null;
    const referenceRoc = referenceRung?.returnOnCapital ?? null;

    return {
      service,
      gradedBasis: basis.total,
      ladder,
      classification,
      requiredPsa10RateVsPsa9: computeRequiredPsa10HitRate({
        fallbackProfit: psa9Profit,
        psa10Profit,
        fallbackLabel: "PSA 9",
      }),
      requiredPsa10RateVsPsa8: computeRequiredPsa10HitRate({
        fallbackProfit: psa8Profit,
        psa10Profit,
        fallbackLabel: "PSA 8",
      }),
      estimatedGradingDays,
      estimatedCapitalLockDays,
      referenceProfit,
      referenceRoc,
      // AI INTELLIGENCE item 13: single canonical formula — see
      // calc/metricDefinitions.ts. Previously computed inline here with the
      // same arithmetic opportunity/engine.ts (FLIP) duplicated separately.
      profitPerCapitalLockDay: profitPerCapitalDay(referenceProfit, estimatedCapitalLockDays),
      annualisedRocIndicator:
        referenceRoc !== null && estimatedCapitalLockDays > 0
          ? round4(referenceRoc * (365 / estimatedCapitalLockDays))
          : null,
      anyPotentialUpcharge: ladder.anyPotentialUpcharge,
    };
  });

  const withProfit = evaluations.filter((e) => e.referenceProfit !== null);
  const withVelocity = evaluations.filter((e) => e.profitPerCapitalLockDay !== null);

  const bestAbsoluteProfit =
    withProfit.length > 0
      ? withProfit.reduce((best, e) => ((e.referenceProfit ?? 0) > (best.referenceProfit ?? 0) ? e : best))
      : null;

  const bestCapitalVelocity =
    withVelocity.length > 0
      ? withVelocity.reduce((best, e) =>
          (e.profitPerCapitalLockDay ?? 0) > (best.profitPerCapitalLockDay ?? 0) ? e : best,
        )
      : null;

  return {
    evaluations,
    bestAbsoluteProfit,
    bestCapitalVelocity,
    bestProfitAndVelocityDiffer:
      bestAbsoluteProfit !== null &&
      bestCapitalVelocity !== null &&
      bestAbsoluteProfit.service.id !== bestCapitalVelocity.service.id,
  };
}
