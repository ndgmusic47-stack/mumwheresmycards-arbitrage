import type { FeeSchedule, PsaGrade } from "../calc/types.js";
import { DEFAULT_FEE_SCHEDULE } from "../calc/types.js";
import { computeGradingBasis } from "../calc/gradingBasis.js";
import { computeGradeLadder } from "../calc/gradeLadder.js";
import { computeGradeScore } from "../scoring/gradeScore.js";
import type { GradeScoreWeights } from "../scoring/gradeScore.js";
import type { ProfileSnapshotInput, GradeProfileResult, MarketProfileSettings } from "./types.js";
import { DEFAULT_MARKET_PROFILE_SETTINGS } from "./types.js";

/**
 * CARD MARKET layer, GRADE strategy: "is this card worth grading at all?",
 * assuming a reference acquisition at roughly its own raw market value.
 * The graded basis/ladder computed here uses the card's OWN raw market
 * value as a REFERENCE purchase price purely to rank and filter the
 * catalogue — it is explicitly not a forecast for any real trade. Forecast
 * economics for an actual purchase are only ever computed in
 * packages/core/src/opportunity, against a real listing price.
 */
export function computeGradeProfile(
  snapshot: ProfileSnapshotInput,
  settings: MarketProfileSettings = DEFAULT_MARKET_PROFILE_SETTINGS,
  feeSchedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
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
    psa10UpsideMultiple: null,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    gradeMarketScore: null,
  };

  if (snapshot.rawMarketPrice === null || snapshot.rawMarketPrice <= 0) {
    return { ...base, ineligibleReason: "No raw market price available — cannot estimate grading economics." };
  }
  if (snapshot.rawMarketPrice < settings.minGradeRawValue) {
    return { ...base, ineligibleReason: `Raw market value £${snapshot.rawMarketPrice} is below the minimum grading floor (£${settings.minGradeRawValue}).` };
  }
  if (snapshot.confidence < settings.minGradeConfidence) {
    return { ...base, ineligibleReason: `Market data confidence ${snapshot.confidence} is below the minimum ${settings.minGradeConfidence}.` };
  }
  if (snapshot.psa9 === null && snapshot.psa10 === null) {
    return { ...base, ineligibleReason: "No PSA9/PSA10 market data available — cannot assess grading upside." };
  }

  const upchargeApplies = snapshot.rawMarketPrice > feeSchedule.gradingUpchargeThreshold;
  const gradingBasis = computeGradingBasis(
    {
      rawPurchasePrice: snapshot.rawMarketPrice,
      sellerPostage: feeSchedule.outboundPostageDefault,
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

  const maxGrade = settings.maxAcceptableBreakEvenGradeForEligibility;
  if (maxGrade !== null && (ladder.breakEvenGrade === null || ladder.breakEvenGrade > maxGrade)) {
    return {
      ...base,
      referenceGradedBasis: gradingBasis.total,
      breakEvenGrade: ladder.breakEvenGrade,
      psa10UpsideMultiple: ladder.psa10UpsideMultiple,
      ineligibleReason:
        ladder.breakEvenGrade === null
          ? "No populated PSA grade breaks even against a reference raw-value acquisition."
          : `Break-even grade PSA ${ladder.breakEvenGrade} is worse than the acceptable maximum (PSA ${maxGrade}).`,
    };
  }

  const rungByGrade = new Map(ladder.rungs.map((r) => [r.grade, r]));
  const worstPopulated = ladder.rungs.find((r) => r.profit !== null) ?? null;
  const psa9Rung = rungByGrade.get(9 as PsaGrade) ?? null;
  const worstCaseReturnOnCapital = worstPopulated?.profit != null ? worstPopulated.profit / gradingBasis.total : -1;
  const psa9ReturnOnCapital = psa9Rung?.profit != null ? psa9Rung.profit / gradingBasis.total : 0;

  const scoreResult = computeGradeScore({
    worstCaseReturnOnCapital,
    psa9ReturnOnCapital,
    psa10UpsideMultiple: ladder.psa10UpsideMultiple ?? 0,
    // The reference basis IS the raw market value, so there is no bargain
    // yet at this layer (bargainRatio 1) — a real listing's actual
    // discount is what feeds the opportunity engine's grade score later.
    bargainRatio: 1,
    slabLiquidity: snapshot.liquidity,
    dataConfidence: snapshot.confidence,
    weights: gradeScoreWeights,
  });

  return {
    ...base,
    eligible: true,
    referenceGradedBasis: gradingBasis.total,
    referenceProfitByGrade: {
      6: rungByGrade.get(6 as PsaGrade)?.profit ?? null,
      7: rungByGrade.get(7 as PsaGrade)?.profit ?? null,
      8: rungByGrade.get(8 as PsaGrade)?.profit ?? null,
      9: rungByGrade.get(9 as PsaGrade)?.profit ?? null,
      10: rungByGrade.get(10 as PsaGrade)?.profit ?? null,
    },
    breakEvenGrade: ladder.breakEvenGrade,
    psa10UpsideMultiple: ladder.psa10UpsideMultiple,
    gradeMarketScore: scoreResult.score,
  };
}
