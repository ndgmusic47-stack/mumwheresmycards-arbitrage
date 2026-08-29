import { resolveCardPrinting } from "../card/resolver.js";
import { computeAcquisitionCost } from "../calc/acquisitionCost.js";
import { computeNetSaleProceeds } from "../calc/netSaleProceeds.js";
import { computeFlipProfit } from "../calc/flipProfit.js";
import { computeGradingBasis } from "../calc/gradingBasis.js";
import { computeGradeLadder } from "../calc/gradeLadder.js";
import { DEFAULT_FEE_SCHEDULE } from "../calc/types.js";
import type { FeeSchedule, PsaGrade } from "../calc/types.js";
import { computeFlipScore } from "../scoring/flipScore.js";
import { computeGradeScore } from "../scoring/gradeScore.js";
import { evaluateFilters } from "../filters/predicates.js";
import type { FilterableOpportunity } from "../filters/types.js";
import { listingQualityFromSeller } from "./listingQuality.js";
import type { ListingCandidate, MarketSnapshotLike, OpportunityCandidate, OpportunityEngineSettings } from "./types.js";

const DEFAULTS = {
  highConfidenceFlipScoreThreshold: 70,
  gradeCandidateScoreThreshold: 60,
  identityRejectConfidenceThreshold: 0.5,
  identityInspectConfidenceThreshold: 0.85,
  liquidityDaysToSale: { LOW: 60, MEDIUM: 30, HIGH: 14, VERY_HIGH: 7 } as const,
};

/**
 * Pure function: listings + market snapshots + settings -> ranked
 * opportunities with an explicit state per ARCHITECTURE.md section 6. No
 * network, no D1 — apps/worker/src/scan/scanRunner.ts is the only place
 * that wires real providers + persistence around this.
 */
export function buildOpportunities(
  listings: ListingCandidate[],
  snapshotsByPrintingHash: Map<string, MarketSnapshotLike>,
  settings: OpportunityEngineSettings,
  feeSchedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): OpportunityCandidate[] {
  const results: OpportunityCandidate[] = [];

  for (const listing of listings) {
    const identityResult = resolveCardPrinting(listing.parsedIdentity);
    const strategies = settings.filters.global.strategy === "BOTH" ? (["FLIP", "GRADE"] as const) : [settings.filters.global.strategy];

    if (!identityResult.ok || !identityResult.printing) {
      for (const strategy of strategies) {
        results.push(
          rejectedIdentityCandidate(
            listing,
            strategy,
            `Card identity could not be resolved: missing ${identityResult.missingFields.join(", ")}`,
          ),
        );
      }
      continue;
    }

    const printing = identityResult.printing;
    const identityConfidence = identityResult.confidence;
    const rejectThreshold = settings.identityRejectConfidenceThreshold ?? DEFAULTS.identityRejectConfidenceThreshold;
    const inspectThreshold = settings.identityInspectConfidenceThreshold ?? DEFAULTS.identityInspectConfidenceThreshold;

    if (identityConfidence < rejectThreshold) {
      for (const strategy of strategies) {
        results.push(
          rejectedIdentityCandidate(
            listing,
            strategy,
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
          state: "WATCH",
          flipScore: null,
          gradeScore: null,
          listingPrice: listing.price,
          totalAcquisitionCost: computeAcquisitionCost({
            purchasePrice: listing.price,
            sellerPostage: listing.shippingCost,
            importTax: listing.importTax,
            acquisitionFees: listing.acquisitionFees,
          }).total,
          liquidity: null,
          confidence: identityConfidence,
          reasoning: ["No market snapshot available yet for this printing — added to watch."],
        });
        continue;
      }

      const needsInspection = identityConfidence < inspectThreshold;

      const candidate =
        strategy === "FLIP"
          ? buildFlipCandidate(listing, printing.printingHash, snapshot, settings, feeSchedule)
          : buildGradeCandidate(listing, printing.printingHash, snapshot, settings, feeSchedule);

      if (needsInspection && !candidate.state.startsWith("REJECTED")) {
        candidate.state = "INSPECT_PHOTOS";
        candidate.reasoning.unshift(
          `Card identity plausible but not fully certain (confidence ${identityConfidence}) — verify from listing photos before acting.`,
        );
      }

      results.push(candidate);
    }
  }

  return results;
}

function rejectedIdentityCandidate(
  listing: ListingCandidate,
  strategy: "FLIP" | "GRADE",
  reason: string,
  cardPrintingHash: string | null = null,
): OpportunityCandidate {
  return {
    listingId: listing.listingId,
    cardPrintingHash,
    strategy,
    state: "REJECTED_CARD_IDENTITY_UNCERTAIN",
    flipScore: null,
    gradeScore: null,
    listingPrice: listing.price,
    totalAcquisitionCost: computeAcquisitionCost({
      purchasePrice: listing.price,
      sellerPostage: listing.shippingCost,
      importTax: listing.importTax,
      acquisitionFees: listing.acquisitionFees,
    }).total,
    liquidity: null,
    confidence: 0,
    reasoning: [reason],
  };
}

function buildFlipCandidate(
  listing: ListingCandidate,
  cardPrintingHash: string,
  snapshot: MarketSnapshotLike,
  settings: OpportunityEngineSettings,
  feeSchedule: FeeSchedule,
): OpportunityCandidate {
  const acquisition = computeAcquisitionCost({
    purchasePrice: listing.price,
    sellerPostage: listing.shippingCost,
    importTax: listing.importTax,
    acquisitionFees: listing.acquisitionFees,
  });

  const qsv = snapshot.rawQsv ?? snapshot.rawMarketPrice;
  const reasoning: string[] = [];

  if (qsv === null) {
    return {
      listingId: listing.listingId,
      cardPrintingHash,
      strategy: "FLIP",
      state: "WATCH",
      flipScore: null,
      gradeScore: null,
      listingPrice: listing.price,
      totalAcquisitionCost: acquisition.total,
      liquidity: snapshot.liquidity,
      confidence: snapshot.confidence,
      reasoning: ["No raw QSV/market price available from the market provider — added to watch."],
    };
  }

  const sale = computeNetSaleProceeds({ salePrice: qsv }, feeSchedule);
  const profit = computeFlipProfit({
    totalAcquisitionCost: acquisition.total,
    netSaleProceeds: sale.netProceeds,
    grossSalePrice: qsv,
  });

  const listingQuality = listingQualityFromSeller(listing.sellerFeedbackScore, listing.sellerFeedbackPct);
  const scoreResult = computeFlipScore({
    returnOnCapital: profit.returnOnCapital,
    netProfit: profit.netProfit,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    listingQuality,
    weights: settings.flipScoreWeights,
  });

  const daysToSaleEstimate = DEFAULTS.liquidityDaysToSale[snapshot.liquidity];

  const filterable: FilterableOpportunity = {
    strategy: "FLIP",
    netProfit: profit.netProfit,
    returnOnCapital: profit.returnOnCapital,
    profitMargin: profit.profitMargin,
    acquisitionPrice: acquisition.total,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    qsv,
    daysToSaleEstimate,
  };

  const evaluation = evaluateFilters(filterable, settings.filters);
  const state = deriveFlipState(
    evaluation.passes,
    evaluation.failures.map((f) => f.filter),
    scoreResult.score,
    settings.highConfidenceFlipScoreThreshold ?? DEFAULTS.highConfidenceFlipScoreThreshold,
  );

  reasoning.push(...evaluation.failures.map((f) => f.reason));
  if (evaluation.passes) reasoning.push(`FLIP SCORE ${scoreResult.score}/100.`);

  return {
    listingId: listing.listingId,
    cardPrintingHash,
    strategy: "FLIP",
    state,
    flipScore: scoreResult.score,
    gradeScore: null,
    listingPrice: listing.price,
    totalAcquisitionCost: acquisition.total,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    qsv,
    expectedNetSaleProceeds: sale.netProceeds,
    expectedNetProfit: profit.netProfit,
    returnOnCapital: profit.returnOnCapital,
    profitMargin: profit.profitMargin,
    daysToSaleEstimate,
    reasoning,
  };
}

function buildGradeCandidate(
  listing: ListingCandidate,
  cardPrintingHash: string,
  snapshot: MarketSnapshotLike,
  settings: OpportunityEngineSettings,
  feeSchedule: FeeSchedule,
): OpportunityCandidate {
  const upchargeApplies = listing.price > feeSchedule.gradingUpchargeThreshold;

  const gradingBasis = computeGradingBasis(
    {
      rawPurchasePrice: listing.price,
      sellerPostage: listing.shippingCost,
      returnShipping: feeSchedule.gradingReturnShippingDefault,
      insurance: feeSchedule.gradingInsuranceDefault,
      upchargeReserveApplies: upchargeApplies,
    },
    feeSchedule,
  );

  const ladder = computeGradeLadder(
    {
      totalGradedBasis: gradingBasis.total,
      psaPrices: { 6: null, 7: snapshot.psa7, 8: snapshot.psa8, 9: snapshot.psa9, 10: snapshot.psa10 },
    },
    feeSchedule,
  );

  const reasoning: string[] = [];
  const rungByGrade = new Map(ladder.rungs.map((r) => [r.grade, r]));
  const worstPopulated = ladder.rungs.find((r) => r.profit !== null) ?? null;
  const psa9Rung = rungByGrade.get(9 as PsaGrade) ?? null;

  const worstCaseReturnOnCapital = worstPopulated?.profit != null ? worstPopulated.profit / gradingBasis.total : -1;
  const psa9ReturnOnCapital = psa9Rung?.profit != null ? psa9Rung.profit / gradingBasis.total : 0;
  const bargainRatio = snapshot.rawMarketPrice ? snapshot.rawMarketPrice / listing.price : 0;

  const scoreResult = computeGradeScore({
    worstCaseReturnOnCapital,
    psa9ReturnOnCapital,
    psa10UpsideMultiple: ladder.psa10UpsideMultiple ?? 0,
    bargainRatio,
    slabLiquidity: snapshot.liquidity,
    dataConfidence: snapshot.confidence,
    weights: settings.gradeScoreWeights,
  });

  if (snapshot.historicalGemRate != null) {
    reasoning.push(
      `Historical gem rate for this printing is ${(snapshot.historicalGemRate * 100).toFixed(1)}% — informational only, NOT a predicted probability of grading PSA 10 for this specific card.`,
    );
  }

  const filterable: FilterableOpportunity = {
    strategy: "GRADE",
    netProfit: psa9Rung?.profit ?? worstPopulated?.profit ?? -Infinity,
    returnOnCapital: psa9ReturnOnCapital,
    profitMargin: psa9Rung?.netProceeds != null && snapshot.psa9 ? (psa9Rung.profit ?? 0) / snapshot.psa9 : 0,
    acquisitionPrice: gradingBasis.total,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    psa10Value: snapshot.psa10,
    psa10UpsideMultiple: ladder.psa10UpsideMultiple,
    breakEvenGrade: ladder.breakEvenGrade,
    gradedBasis: gradingBasis.total,
  };

  const evaluation = evaluateFilters(filterable, settings.filters);
  const state = deriveGradeState(
    evaluation.passes,
    evaluation.failures.map((f) => f.filter),
    scoreResult.score,
    ladder.breakEvenGrade,
    settings.gradeCandidateScoreThreshold ?? DEFAULTS.gradeCandidateScoreThreshold,
  );

  reasoning.push(...evaluation.failures.map((f) => f.reason));
  if (evaluation.passes) reasoning.push(`GRADE SCORE ${scoreResult.score}/100.`);

  return {
    listingId: listing.listingId,
    cardPrintingHash,
    strategy: "GRADE",
    state,
    flipScore: null,
    gradeScore: scoreResult.score,
    listingPrice: listing.price,
    totalAcquisitionCost: gradingBasis.total,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    totalGradedBasis: gradingBasis.total,
    psa6Profit: rungByGrade.get(6 as PsaGrade)?.profit ?? null,
    psa7Profit: rungByGrade.get(7 as PsaGrade)?.profit ?? null,
    psa8Profit: rungByGrade.get(8 as PsaGrade)?.profit ?? null,
    psa9Profit: rungByGrade.get(9 as PsaGrade)?.profit ?? null,
    psa10Profit: rungByGrade.get(10 as PsaGrade)?.profit ?? null,
    breakEvenGrade: ladder.breakEvenGrade,
    psa10UpsideMultiple: ladder.psa10UpsideMultiple,
    reasoning,
  };
}

function deriveFlipState(
  passes: boolean,
  failedFilters: string[],
  flipScore: number,
  highConfidenceThreshold: number,
): OpportunityCandidate["state"] {
  if (!passes) {
    if (failedFilters.includes("minLiquidity")) return "REJECTED_LIQUIDITY_TOO_LOW";
    if (failedFilters.some((f) => ["minNetProfit", "minReturnOnCapital", "minProfitMargin"].includes(f))) {
      return "REJECTED_MARGIN_TOO_LOW";
    }
    return "PASS";
  }
  return flipScore >= highConfidenceThreshold ? "HIGH_CONFIDENCE_FLIP" : "WATCH";
}

function deriveGradeState(
  passes: boolean,
  failedFilters: string[],
  gradeScore: number,
  breakEvenGrade: PsaGrade | null,
  candidateThreshold: number,
): OpportunityCandidate["state"] {
  if (!passes) {
    if (failedFilters.includes("minLiquidity")) return "REJECTED_LIQUIDITY_TOO_LOW";
    if (failedFilters.some((f) => ["minNetProfit", "minReturnOnCapital", "minProfitMargin", "maxGradedBasis"].includes(f))) {
      return "REJECTED_MARGIN_TOO_LOW";
    }
    return "PASS";
  }
  return gradeScore >= candidateThreshold && breakEvenGrade !== null ? "GRADE_CANDIDATE" : "WATCH";
}
