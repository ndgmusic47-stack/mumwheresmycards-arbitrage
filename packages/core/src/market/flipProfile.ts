import type { FeeSchedule } from "../calc/types.js";
import { DEFAULT_FEE_SCHEDULE, LIQUIDITY_ORDER } from "../calc/types.js";
import type { GlobalFilters } from "../filters/types.js";
import { computeNetSaleProceeds } from "../calc/netSaleProceeds.js";
import { computeFlipScore } from "../scoring/flipScore.js";
import type { FlipScoreWeights } from "../scoring/flipScore.js";
import type { ProfileSnapshotInput, FlipProfileResult, MarketProfileSettings } from "./types.js";
import { DEFAULT_MARKET_PROFILE_SETTINGS } from "./types.js";

/**
 * CARD MARKET layer, FLIP strategy (see ARCHITECTURE.md "three layers"):
 * "is this card economically interesting to flip at all?" — computed once
 * per catalogued card from market data ALONE, before any eBay search. This
 * is NOT a per-listing profit calculation; that stays in
 * packages/core/src/opportunity, fed by a real listing price once eBay
 * supply is searched. The headline output, `maxProfitableAcquisitionPrice`,
 * is what tells the eBay-search step which asking prices are even worth
 * looking at for this card.
 */
export function computeFlipProfile(
  snapshot: ProfileSnapshotInput,
  globalFilters: Pick<GlobalFilters, "minNetProfit" | "minReturnOnCapital">,
  settings: MarketProfileSettings = DEFAULT_MARKET_PROFILE_SETTINGS,
  feeSchedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
  flipScoreWeights?: Partial<FlipScoreWeights>,
): FlipProfileResult {
  const qsv = snapshot.rawQsv ?? snapshot.rawMarketPrice;

  const base: FlipProfileResult = {
    eligible: false,
    ineligibleReason: null,
    rawMarketValue: snapshot.rawMarketPrice,
    conservativeQsv: qsv,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    maxProfitableAcquisitionPrice: null,
    flipMarketScore: null,
  };

  if (qsv === null || qsv <= 0) {
    return { ...base, ineligibleReason: "No usable raw market/QSV price from market data." };
  }
  if (qsv < settings.minFlipRawValue) {
    return {
      ...base,
      ineligibleReason: `QSV £${qsv} is below the minimum flip floor (£${settings.minFlipRawValue}) — not worth the operational overhead of a tiny flip.`,
    };
  }
  if (LIQUIDITY_ORDER[snapshot.liquidity] < LIQUIDITY_ORDER[settings.minFlipLiquidity]) {
    return { ...base, ineligibleReason: `Liquidity ${snapshot.liquidity} is below the minimum ${settings.minFlipLiquidity}.` };
  }
  if (snapshot.confidence < settings.minFlipConfidence) {
    return { ...base, ineligibleReason: `Market data confidence ${snapshot.confidence} is below the minimum ${settings.minFlipConfidence}.` };
  }

  // Solve for the highest total acquisition cost that would still clear
  // BOTH the minimum net profit and minimum ROC filters against this QSV:
  //   netProceeds - acquisition >= minNetProfit        => acquisition <= netProceeds - minNetProfit
  //   netProceeds - acquisition >= acquisition*minROC   => acquisition <= netProceeds / (1 + minROC)
  // No listing-specific postage/import tax is known yet at this layer —
  // those apply for real once an actual listing reaches the opportunity
  // engine; this is a reference ceiling for search prioritisation.
  const sale = computeNetSaleProceeds({ salePrice: qsv }, feeSchedule);
  const capFromProfit = sale.netProceeds - globalFilters.minNetProfit;
  const capFromRoc = sale.netProceeds / (1 + globalFilters.minReturnOnCapital);
  const maxProfitableAcquisitionPrice = round2(Math.max(0, Math.min(capFromProfit, capFromRoc)));

  if (maxProfitableAcquisitionPrice <= 0) {
    return {
      ...base,
      maxProfitableAcquisitionPrice: 0,
      ineligibleReason: "No acquisition price — even £0 — would clear the minimum profit/ROC filters at this QSV once fees are deducted.",
    };
  }

  // Reference score for ranking/prioritisation only: uses the computed
  // ceiling itself as a stand-in acquisition price so the resulting ROC is
  // exactly at the filter boundary — NOT a claim about actual achievable
  // profit for any real listing.
  const referenceNetProfit = round2(sale.netProceeds - maxProfitableAcquisitionPrice);
  const referenceRoc = referenceNetProfit / maxProfitableAcquisitionPrice;

  const scoreResult = computeFlipScore({
    returnOnCapital: referenceRoc,
    netProfit: referenceNetProfit,
    liquidity: snapshot.liquidity,
    confidence: snapshot.confidence,
    listingQuality: 0.5, // unknown until a real listing exists — neutral placeholder
    weights: flipScoreWeights,
  });

  return {
    ...base,
    eligible: true,
    maxProfitableAcquisitionPrice,
    flipMarketScore: scoreResult.score,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
