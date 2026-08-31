import type { ExitMarketFeeModel } from "../calc/fees.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL } from "../calc/fees.js";
import type {
  GradingBatchSettings,
  GradingConsumables,
  GradingService,
  PsaGrade,
  SellingCostSettings,
} from "../calc/types.js";
import {
  DEFAULT_GRADING_BATCH,
  DEFAULT_GRADING_CONSUMABLES,
  DEFAULT_GRADING_SERVICES,
  DEFAULT_SELLING_COSTS,
} from "../calc/types.js";
import type { ClassificationSettings } from "../grading/classification.js";
import { DEFAULT_CLASSIFICATION_SETTINGS } from "../grading/classification.js";
import { compareGradingServices } from "../grading/serviceComparison.js";
import { computeGradeScore } from "../scoring/gradeScore.js";
import type { GradeScoreWeights } from "../scoring/gradeScore.js";
import type { GradeProfileResult, MarketProfileSettings, ProfileSnapshotInput } from "./types.js";
import { DEFAULT_MARKET_PROFILE_SETTINGS } from "./types.js";

/**
 * CARD MARKET layer, GRADE strategy: "is this card worth grading at all,
 * assuming a reference acquisition at roughly its own raw market value?"
 *
 * The reference basis uses the card's OWN raw market value purely to rank
 * and filter the catalogue — it is explicitly not a forecast for a real
 * trade. Real economics are only ever computed against a real listing price
 * in packages/core/src/opportunity.
 *
 * Eligibility is decided by ECONOMIC CLASSIFICATION, not by a break-even
 * grade cutoff. The previous model required the break-even grade to beat a
 * fixed threshold, which discarded every asymmetric candidate (lower grades
 * lose, PSA 10 is exceptional) before a listing was ever seen — precisely
 * the structure this business most wants to discover.
 */
export function computeGradeProfile(
  snapshot: ProfileSnapshotInput,
  settings: MarketProfileSettings = DEFAULT_MARKET_PROFILE_SETTINGS,
  services: GradingService[] = DEFAULT_GRADING_SERVICES,
  batch: GradingBatchSettings = DEFAULT_GRADING_BATCH,
  consumables: GradingConsumables = DEFAULT_GRADING_CONSUMABLES,
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
  sellingCosts: SellingCostSettings = DEFAULT_SELLING_COSTS,
  classificationSettings: ClassificationSettings = DEFAULT_CLASSIFICATION_SETTINGS,
  usdPerGbp: number | null = null,
  gradeScoreWeights?: Partial<GradeScoreWeights>,
): GradeProfileResult {
  const base: GradeProfileResult = {
    eligible: false,
    ineligibleReason: null,
    rawMarketValue: snapshot.rawMarketPrice,
    psa7: snapshot.psa7,
    psa8: snapshot.psa8,
    psa9: snapshot.psa9,
    psa10: snapshot.psa10,
    referenceGradedBasis: null,
    referenceProfitByGrade: {},
    breakEvenGrade: null,
    psa10GrossMultiple: null,
    economicClass: "UNCLASSIFIED",
    economicClassRationale: null,
    requiredPsa10RateVsPsa9: null,
    referenceServiceId: null,
    estimatedCapitalLockDays: null,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    gradeMarketScore: null,
  };

  if (snapshot.rawMarketPrice === null || snapshot.rawMarketPrice <= 0) {
    return { ...base, ineligibleReason: "No raw market price available — cannot estimate grading economics." };
  }
  if (snapshot.rawMarketPrice < settings.minGradeRawValue) {
    return {
      ...base,
      ineligibleReason: `Raw market value £${snapshot.rawMarketPrice} is below the minimum grading floor (£${settings.minGradeRawValue}).`,
    };
  }
  if (snapshot.confidence < settings.minGradeConfidence) {
    return {
      ...base,
      ineligibleReason: `Market data confidence ${snapshot.confidence} is below the minimum ${settings.minGradeConfidence}.`,
    };
  }
  if (snapshot.psa9 === null && snapshot.psa10 === null) {
    return { ...base, ineligibleReason: "No PSA9/PSA10 market data available — cannot assess grading upside." };
  }

  const comparison = compareGradingServices({
    rawPurchasePrice: snapshot.rawMarketPrice,
    sellerPostage: 0, // reference basis — no specific listing's postage is known yet
    slabValues: {
      6: snapshot.psa6 ?? null,
      7: snapshot.psa7,
      8: snapshot.psa8,
      9: snapshot.psa9,
      10: snapshot.psa10,
    },
    slabLiquidity: snapshot.liquidity,
    services,
    batch,
    consumables,
    feeModel,
    sellingCosts,
    classificationSettings,
    usdPerGbp,
  });

  if (comparison.evaluations.length === 0) {
    return { ...base, ineligibleReason: "No enabled grading service available to evaluate this card." };
  }

  // Pick the strongest structure available across services — a card that is
  // DOWNSIDE PROTECTED on one service and unclassified on another is a
  // downside-protected opportunity on that service.
  const ranked = [...comparison.evaluations].sort(
    (a, b) => classRank(b.classification.economicClass) - classRank(a.classification.economicClass),
  );
  const best = ranked[0]!; // non-empty: guarded by the evaluations.length check above
  const classification = best.classification;

  const profitByGrade: Partial<Record<PsaGrade, number | null>> = {};
  for (const rung of best.ladder.rungs) profitByGrade[rung.grade] = rung.profit;

  const enriched: GradeProfileResult = {
    ...base,
    referenceGradedBasis: best.gradedBasis,
    referenceProfitByGrade: profitByGrade,
    breakEvenGrade: best.ladder.breakEvenGrade,
    psa10GrossMultiple: best.ladder.psa10GrossMultiple,
    economicClass: classification.economicClass,
    economicClassRationale: classification.rationale,
    requiredPsa10RateVsPsa9: best.requiredPsa10RateVsPsa9.requiredRate,
    referenceServiceId: best.service.id,
    estimatedCapitalLockDays: best.estimatedCapitalLockDays,
  };

  if (!settings.eligibleEconomicClasses.includes(classification.economicClass)) {
    return {
      ...enriched,
      ineligibleReason:
        classification.economicClass === "UNCLASSIFIED"
          ? `No viable grading structure at a reference acquisition of £${snapshot.rawMarketPrice}: ${classification.unclassifiedReasons.join(" ")}`
          : `Economic class ${classification.economicClass} is not in the catalogue-eligible set.`,
    };
  }

  return {
    ...enriched,
    eligible: true,
    gradeMarketScore: computeGradeScore({
      economicClass: classification.economicClass,
      psa7Profit: profitByGrade[7] ?? null,
      psa9Profit: profitByGrade[9] ?? null,
      psa9ReturnOnCapital: best.ladder.rungs.find((r) => r.grade === 9)?.returnOnCapital ?? 0,
      psa10GrossMultiple: best.ladder.psa10GrossMultiple ?? 0,
      requiredPsa10Rate: best.requiredPsa10RateVsPsa9.requiredRate,
      gradedBasis: best.gradedBasis,
      slabLiquidity: snapshot.liquidity,
      dataConfidence: snapshot.confidence,
      estimatedCapitalLockDays: best.estimatedCapitalLockDays,
      weights: gradeScoreWeights,
    }).score,
  };
}

function classRank(economicClass: string): number {
  switch (economicClass) {
    case "DOWNSIDE_PROTECTED":
      return 3;
    case "BALANCED":
      return 2;
    case "ASYMMETRIC":
      return 1;
    default:
      return 0;
  }
}
