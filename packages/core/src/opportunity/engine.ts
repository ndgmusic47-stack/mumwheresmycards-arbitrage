import { resolveCardPrinting } from "../card/resolver.js";
import { computeAcquisitionCost } from "../calc/acquisitionCost.js";
import { computeNetSaleProceeds } from "../calc/netSaleProceeds.js";
import { computeFlipProfit } from "../calc/flipProfit.js";
import { round2, round4 } from "../calc/fees.js";
import type { LiquidityLevel } from "../calc/types.js";
import { computeQsv } from "../market/qsv.js";
import { compareGradingServices, DEFAULT_SLAB_DAYS_TO_SALE } from "../grading/serviceComparison.js";
import { computeFlipScore } from "../scoring/flipScore.js";
import { computeGradeScore } from "../scoring/gradeScore.js";
import { qualifyFlip, qualifyGrade } from "../filters/predicates.js";
import { listingQualityFromSeller } from "./listingQuality.js";
import type {
  ListingCandidate,
  MarketSnapshotLike,
  OpportunityCandidate,
  OpportunityEngineSettings,
} from "./types.js";

const DEFAULTS = {
  identityRejectConfidenceThreshold: 0.5,
  identityInspectConfidenceThreshold: 0.85,
  rawDaysToSale: { LOW: 60, MEDIUM: 30, HIGH: 14, VERY_HIGH: 7 } as Record<LiquidityLevel, number>,
};

/**
 * Pure function: listings + market snapshots + settings -> opportunities.
 *
 * The order of operations is the whole point of this rewrite:
 *
 *   1. Resolve card identity (unchanged — never guesses a missing field).
 *   2. Compute REAL ECONOMICS from the fee model, QSV model and grade ladder.
 *   3. QUALIFY on those economics alone (../filters/predicates.ts).
 *   4. SCORE, purely to rank the ones that qualified.
 *
 * Step 4 can never promote or demote across step 3. Previously a candidate
 * that cleared every economic filter still had to beat a hardcoded score
 * threshold (70 for flips, 60 for grades) to be labelled an opportunity,
 * which meant an arbitrary weighted blend silently vetoed real trades.
 */
export function buildOpportunities(
  listings: ListingCandidate[],
  snapshotsByPrintingHash: Map<string, MarketSnapshotLike>,
  settings: OpportunityEngineSettings,
): OpportunityCandidate[] {
  const results: OpportunityCandidate[] = [];
  const rejectThreshold = settings.identityRejectConfidenceThreshold ?? DEFAULTS.identityRejectConfidenceThreshold;
  const inspectThreshold = settings.identityInspectConfidenceThreshold ?? DEFAULTS.identityInspectConfidenceThreshold;

  const strategies =
    settings.qualification.strategy === "BOTH"
      ? (["FLIP", "GRADE"] as const)
      : ([settings.qualification.strategy] as const);

  for (const listing of listings) {
    const identityResult = resolveCardPrinting(listing.parsedIdentity);
    const acquisition = computeAcquisitionCost({
      purchasePrice: listing.price,
      sellerPostage: listing.shippingCost,
      importTax: listing.importTax,
      acquisitionFees: listing.acquisitionFees,
    });

    if (!identityResult.ok || !identityResult.printing) {
      for (const strategy of strategies) {
        results.push(
          identityRejected(
            listing,
            strategy,
            acquisition.total,
            `Card identity could not be resolved: missing ${identityResult.missingFields.join(", ")}`,
          ),
        );
      }
      continue;
    }

    const printing = identityResult.printing;
    const identityConfidence = identityResult.confidence;

    if (identityConfidence < rejectThreshold) {
      for (const strategy of strategies) {
        results.push(
          identityRejected(
            listing,
            strategy,
            acquisition.total,
            `Identity resolved but confidence too low (${identityConfidence}): ${identityResult.notes.join("; ")}`,
            printing.printingHash,
          ),
        );
      }
      continue;
    }

    const snapshot = snapshotsByPrintingHash.get(printing.printingHash) ?? null;

    for (const strategy of strategies) {
      if (!snapshot) {
        results.push({
          listingId: listing.listingId,
          cardPrintingHash: printing.printingHash,
          strategy,
          state: "NO_MARKET_DATA",
          score: null,
          qualifies: false,
          qualificationFailures: [],
          listingPrice: listing.price,
          totalAcquisitionCost: acquisition.total,
          liquidity: null,
          confidence: 0,
          identityConfidence,
          reasoning: ["No market snapshot available yet for this printing — economics not computable."],
        });
        continue;
      }

      const candidate =
        strategy === "FLIP"
          ? buildFlipCandidate(listing, printing.printingHash, acquisition.total, snapshot, settings, identityConfidence)
          : buildGradeCandidate(listing, printing.printingHash, acquisition.total, snapshot, settings, identityConfidence);

      // Identity uncertainty downgrades a QUALIFIED state to INSPECT_PHOTOS —
      // the economics still stand, we just need eyes on the card first.
      if (candidate.qualifies && identityConfidence < inspectThreshold) {
        candidate.state = "INSPECT_PHOTOS";
        candidate.reasoning.unshift(
          `Economics qualify, but card identity is not fully certain (confidence ${identityConfidence}) — verify from listing photos before acting.`,
        );
      }

      results.push(candidate);
    }
  }

  return results;
}

function buildFlipCandidate(
  listing: ListingCandidate,
  cardPrintingHash: string,
  totalAcquisitionCost: number,
  snapshot: MarketSnapshotLike,
  settings: OpportunityEngineSettings,
  identityConfidence: number,
): OpportunityCandidate {
  const reasoning: string[] = [];

  // QSV from SOLD medians only — active asking prices never enter here.
  const qsvResult = computeQsv(
    {
      median7d: snapshot.rawMedian7d ?? null,
      median30d: snapshot.rawMedian30d ?? null,
      fallbackReference: snapshot.rawQsv ?? snapshot.rawMarketPrice,
      baseConfidence: snapshot.confidence,
    },
    settings.qsvSettings,
  );
  reasoning.push(...qsvResult.notes);

  const base: OpportunityCandidate = {
    listingId: listing.listingId,
    cardPrintingHash,
    strategy: "FLIP",
    state: "WATCH",
    score: null,
    qualifies: false,
    qualificationFailures: [],
    listingPrice: listing.price,
    totalAcquisitionCost,
    liquidity: snapshot.liquidity,
    confidence: qsvResult.confidence,
    identityConfidence,
    qsv: qsvResult.qsv,
    qsvBasis: qsvResult.basis,
    isHighConfidenceQsv: qsvResult.isHighConfidenceQsv,
    reasoning,
  };

  if (qsvResult.qsv === null) {
    return { ...base, state: "NO_MARKET_DATA" };
  }

  const sale = computeNetSaleProceeds(
    { itemPrice: qsvResult.qsv },
    settings.feeModel,
    settings.sellingCosts,
  );

  const daysToSaleTable = settings.rawDaysToSale ?? DEFAULTS.rawDaysToSale;
  const expectedDaysToSale = daysToSaleTable[snapshot.liquidity];

  const profit = computeFlipProfit({
    totalAcquisitionCost,
    netSaleProceeds: sale.netProceeds,
    buyerPayment: sale.buyerPayment,
    expectedDaysToSale,
  });

  const qualification = qualifyFlip(
    {
      netProfit: profit.netProfit,
      returnOnCapital: profit.returnOnCapital,
      totalAcquisitionCost,
      qsv: qsvResult.qsv,
      liquidity: snapshot.liquidity,
      confidence: qsvResult.confidence,
      expectedDaysToSale,
      isHighConfidenceQsv: qsvResult.isHighConfidenceQsv,
    },
    settings.qualification.flip,
  );

  // Score is computed for EVERY candidate, but only ever used for ordering.
  const score = computeFlipScore({
    returnOnCapital: profit.returnOnCapital,
    netProfit: profit.netProfit,
    liquidity: snapshot.liquidity,
    confidence: qsvResult.confidence,
    listingQuality: listingQualityFromSeller(listing.sellerFeedbackScore, listing.sellerFeedbackPct),
    weights: settings.flipScoreWeights,
  }).score;

  reasoning.push(
    `Delivered acquisition £${totalAcquisitionCost.toFixed(2)} -> QSV £${qsvResult.qsv.toFixed(2)}, net of £${sale.fees.totalSellingFees.toFixed(2)} selling fees and £${(sale.outboundPostage + sale.packaging + sale.insurance).toFixed(2)} fulfilment = £${sale.netProceeds.toFixed(2)} net cash.`,
  );
  reasoning.push(...qualification.failures.map((f) => f.reason));

  return {
    ...base,
    state: qualification.qualifies ? "QUALIFIED_FLIP" : "WATCH",
    score,
    qualifies: qualification.qualifies,
    qualificationFailures: qualification.failures,
    buyerPayment: sale.buyerPayment,
    sellingFees: sale.fees.totalSellingFees,
    expectedNetSaleProceeds: sale.netProceeds,
    expectedNetProfit: profit.netProfit,
    returnOnCapital: profit.returnOnCapital,
    profitMargin: profit.profitMargin,
    expectedDaysToSale,
    profitPerCapitalDay: expectedDaysToSale > 0 ? round2(profit.netProfit / expectedDaysToSale) : null,
  };
}

function buildGradeCandidate(
  listing: ListingCandidate,
  cardPrintingHash: string,
  totalAcquisitionCost: number,
  snapshot: MarketSnapshotLike,
  settings: OpportunityEngineSettings,
  identityConfidence: number,
): OpportunityCandidate {
  const reasoning: string[] = [];

  const base: OpportunityCandidate = {
    listingId: listing.listingId,
    cardPrintingHash,
    strategy: "GRADE",
    state: "WATCH",
    score: null,
    qualifies: false,
    qualificationFailures: [],
    listingPrice: listing.price,
    totalAcquisitionCost,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    identityConfidence,
    reasoning,
  };

  if (snapshot.psa9 === null && snapshot.psa10 === null) {
    reasoning.push("No PSA 9 or PSA 10 slab pricing available — grading economics not computable.");
    return { ...base, state: "NO_MARKET_DATA" };
  }

  // Evaluate against EVERY enabled service — profit and capital velocity
  // often point at different tiers, and both are surfaced.
  const comparison = compareGradingServices({
    rawPurchasePrice: listing.price,
    sellerPostage: listing.shippingCost,
    importTax: listing.importTax,
    acquisitionFees: listing.acquisitionFees,
    slabValues: {
      6: snapshot.psa6 ?? null,
      7: snapshot.psa7,
      8: snapshot.psa8,
      9: snapshot.psa9,
      10: snapshot.psa10,
    },
    slabLiquidity: snapshot.liquidity,
    services: settings.gradingServices.filter(
      (s) =>
        settings.qualification.grade.enabledGraderIds.includes(s.graderId) &&
        settings.qualification.grade.enabledServiceIds.includes(s.id),
    ),
    batch: settings.gradingBatch,
    consumables: settings.gradingConsumables,
    feeModel: settings.feeModel,
    sellingCosts: settings.sellingCosts,
    classificationSettings: settings.classificationSettings,
    usdPerGbp: settings.usdPerGbp,
    slabDaysToSale: settings.slabDaysToSale ?? DEFAULT_SLAB_DAYS_TO_SALE,
  });

  if (comparison.evaluations.length === 0) {
    reasoning.push("No enabled grading service is eligible for this card.");
    return { ...base, state: "WATCH" };
  }

  // Qualify against each service, then present the best QUALIFYING one by
  // absolute profit — falling back to the best non-qualifying evaluation so
  // the near-miss economics are still visible on the dashboard.
  const qualified = comparison.evaluations
    .map((evaluation) => ({
      evaluation,
      qualification: qualifyGrade(
        {
          economicClass: evaluation.classification.economicClass,
          rawAcquisitionCost: totalAcquisitionCost,
          totalGradedBasis: evaluation.gradedBasis,
          psa10Value: snapshot.psa10,
          psa10Profit: profitAt(evaluation, 10),
          psa10GrossMultiple: evaluation.ladder.psa10GrossMultiple,
          psa9Profit: profitAt(evaluation, 9),
          psa8Profit: profitAt(evaluation, 8),
          breakEvenGrade: evaluation.ladder.breakEvenGrade,
          requiredPsa10RateVsPsa9: evaluation.requiredPsa10RateVsPsa9.requiredRate,
          liquidity: snapshot.liquidity,
          confidence: snapshot.confidence,
          estimatedCapitalLockDays: evaluation.estimatedCapitalLockDays,
          graderId: evaluation.service.graderId,
          serviceId: evaluation.service.id,
        },
        settings.qualification.grade,
      ),
    }))
    .sort((a, b) => (profitAt(b.evaluation, 9) ?? -Infinity) - (profitAt(a.evaluation, 9) ?? -Infinity));

  // Non-empty: guarded by the evaluations.length check above.
  const chosen = qualified.find((q) => q.qualification.qualifies) ?? qualified[0]!;
  const evaluation = chosen.evaluation;
  const classification = evaluation.classification;

  reasoning.push(classification.rationale);
  reasoning.push(
    `Graded basis £${evaluation.gradedBasis.toFixed(2)} via ${evaluation.service.name} (£${evaluation.service.feePerCard.toFixed(2)} service fee + £${(evaluation.gradedBasis - evaluation.service.feePerCard - listing.price - listing.shippingCost).toFixed(2)} shared batch logistics/consumables at a ${settings.gradingBatch.batchSize}-card batch).`,
  );
  reasoning.push(evaluation.requiredPsa10RateVsPsa9.explanation);
  if (evaluation.anyPotentialUpcharge) {
    reasoning.push(
      `POTENTIAL UPCHARGE — at least one grade's slab value exceeds the ${evaluation.service.name} declared-value cap. The exact escalation cost is not known before submission.`,
    );
  }
  if (comparison.bestProfitAndVelocityDiffer && comparison.bestCapitalVelocity) {
    reasoning.push(
      `${comparison.bestCapitalVelocity.service.name} returns capital faster (£${(comparison.bestCapitalVelocity.profitPerCapitalLockDay ?? 0).toFixed(2)}/day vs £${(evaluation.profitPerCapitalLockDay ?? 0).toFixed(2)}/day) — estimates only.`,
    );
  }
  reasoning.push(...chosen.qualification.failures.map((f) => f.reason));
  if (classification.economicClass === "UNCLASSIFIED") {
    reasoning.push(...classification.unclassifiedReasons);
  }

  const score = computeGradeScore({
    economicClass: classification.economicClass,
    psa7Profit: profitAt(evaluation, 7),
    psa9Profit: profitAt(evaluation, 9),
    psa9ReturnOnCapital: rocAt(evaluation, 9) ?? 0,
    psa10GrossMultiple: evaluation.ladder.psa10GrossMultiple ?? 0,
    requiredPsa10Rate: evaluation.requiredPsa10RateVsPsa9.requiredRate,
    gradedBasis: evaluation.gradedBasis,
    slabLiquidity: snapshot.liquidity,
    dataConfidence: snapshot.confidence,
    estimatedCapitalLockDays: evaluation.estimatedCapitalLockDays,
    weights: settings.gradeScoreWeights,
  }).score;

  return {
    ...base,
    state: chosen.qualification.qualifies ? "QUALIFIED_GRADE" : "WATCH",
    score,
    qualifies: chosen.qualification.qualifies,
    qualificationFailures: chosen.qualification.failures,
    graderId: evaluation.service.graderId,
    gradingServiceId: evaluation.service.id,
    gradingServiceName: evaluation.service.name,
    totalGradedBasis: evaluation.gradedBasis,
    gradeRungs: evaluation.ladder.rungs.map((r) => ({ ...r })),
    psa6Profit: profitAt(evaluation, 6),
    psa7Profit: profitAt(evaluation, 7),
    psa8Profit: profitAt(evaluation, 8),
    psa9Profit: profitAt(evaluation, 9),
    psa10Profit: profitAt(evaluation, 10),
    psa10Value: snapshot.psa10,
    breakEvenGrade: evaluation.ladder.breakEvenGrade,
    psa10GrossMultiple: evaluation.ladder.psa10GrossMultiple,
    economicClass: classification.economicClass,
    economicClassRationale: classification.rationale,
    requiredPsa10RateVsPsa9: evaluation.requiredPsa10RateVsPsa9.requiredRate,
    requiredPsa10RateVsPsa8: evaluation.requiredPsa10RateVsPsa8.requiredRate,
    estimatedGradingDays: evaluation.estimatedGradingDays,
    estimatedCapitalLockDays: evaluation.estimatedCapitalLockDays,
    annualisedRocIndicator: evaluation.annualisedRocIndicator,
    profitPerCapitalDay: evaluation.profitPerCapitalLockDay,
    potentialUpcharge: evaluation.anyPotentialUpcharge,
    betterVelocityServiceId:
      comparison.bestProfitAndVelocityDiffer && comparison.bestCapitalVelocity
        ? comparison.bestCapitalVelocity.service.id
        : null,
  };
}

function profitAt(
  evaluation: { ladder: { rungs: { grade: number; profit: number | null }[] } },
  grade: number,
): number | null {
  return evaluation.ladder.rungs.find((r) => r.grade === grade)?.profit ?? null;
}

function rocAt(
  evaluation: { ladder: { rungs: { grade: number; returnOnCapital: number | null }[] } },
  grade: number,
): number | null {
  return evaluation.ladder.rungs.find((r) => r.grade === grade)?.returnOnCapital ?? null;
}

function identityRejected(
  listing: ListingCandidate,
  strategy: "FLIP" | "GRADE",
  totalAcquisitionCost: number,
  reason: string,
  cardPrintingHash: string | null = null,
): OpportunityCandidate {
  return {
    listingId: listing.listingId,
    cardPrintingHash,
    strategy,
    state: "REJECTED_CARD_IDENTITY_UNCERTAIN",
    score: null,
    qualifies: false,
    qualificationFailures: [],
    listingPrice: listing.price,
    totalAcquisitionCost,
    liquidity: null,
    confidence: 0,
    identityConfidence: 0,
    reasoning: [reason],
  };
}

export { round4 };
