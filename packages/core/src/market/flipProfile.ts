import type { ExitMarketFeeModel } from "../calc/fees.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL, round2 } from "../calc/fees.js";
import type { SellingCostSettings } from "../calc/types.js";
import { DEFAULT_SELLING_COSTS, LIQUIDITY_ORDER } from "../calc/types.js";
import type { FlipQualificationRules } from "../filters/types.js";
import { DEFAULT_FLIP_QUALIFICATION } from "../filters/types.js";
import { computeNetSaleProceeds } from "../calc/netSaleProceeds.js";
import { computeFlipScore } from "../scoring/flipScore.js";
import type { FlipScoreWeights } from "../scoring/flipScore.js";
import { computeQsv, DEFAULT_QSV_SETTINGS, type QsvSettings } from "./qsv.js";
import type { FlipProfileResult, MarketProfileSettings, ProfileSnapshotInput } from "./types.js";
import { DEFAULT_MARKET_PROFILE_SETTINGS } from "./types.js";

/**
 * CARD MARKET layer, FLIP strategy: "could this card ever be worth flipping,
 * at SOME price?" — computed per catalogued card from market data alone,
 * before any eBay search.
 *
 * The headline output is `maxProfitableAcquisitionPrice`: the highest
 * all-in cost at which this card would still clear the flip qualification
 * bar. That is what tells the eBay search step which asking prices are
 * worth looking at. It is NOT a profit forecast — a real forecast only
 * exists once an actual listing price is known.
 */
export function computeFlipProfile(
  snapshot: ProfileSnapshotInput,
  qualification: Pick<FlipQualificationRules, "minNetProfit" | "minReturnOnCapital"> = DEFAULT_FLIP_QUALIFICATION,
  settings: MarketProfileSettings = DEFAULT_MARKET_PROFILE_SETTINGS,
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
  sellingCosts: SellingCostSettings = DEFAULT_SELLING_COSTS,
  qsvSettings: QsvSettings = DEFAULT_QSV_SETTINGS,
  flipScoreWeights?: Partial<FlipScoreWeights>,
): FlipProfileResult {
  const qsvResult = computeQsv(
    {
      median7d: snapshot.rawMedian7d ?? null,
      median30d: snapshot.rawMedian30d ?? null,
      fallbackReference: snapshot.rawQsv ?? snapshot.rawMarketPrice,
      baseConfidence: snapshot.confidence,
    },
    qsvSettings,
  );

  const base: FlipProfileResult = {
    eligible: false,
    ineligibleReason: null,
    rawMarketValue: snapshot.rawMarketPrice,
    conservativeQsv: qsvResult.qsv,
    qsvBasis: qsvResult.basis,
    isHighConfidenceQsv: qsvResult.isHighConfidenceQsv,
    liquidity: snapshot.liquidity,
    confidence: qsvResult.confidence,
    maxProfitableAcquisitionPrice: null,
    discoveryMaxAcquisitionPrice: null,
    flipMarketScore: null,
  };

  const qsv = qsvResult.qsv;

  if (qsv === null || qsv <= 0) {
    return { ...base, ineligibleReason: "No usable sold-median or reference price from market data." };
  }
  if (qsv < settings.minFlipRawValue) {
    return {
      ...base,
      ineligibleReason: `QSV £${qsv} is below the minimum flip floor (£${settings.minFlipRawValue}) — not worth the operational overhead of a tiny flip.`,
    };
  }
  if (LIQUIDITY_ORDER[snapshot.liquidity] < LIQUIDITY_ORDER[settings.minFlipLiquidity]) {
    return {
      ...base,
      ineligibleReason: `Liquidity ${snapshot.liquidity} is below the minimum ${settings.minFlipLiquidity}.`,
    };
  }
  if (qsvResult.confidence < settings.minFlipConfidence) {
    return {
      ...base,
      ineligibleReason: `Market data confidence ${qsvResult.confidence} is below the minimum ${settings.minFlipConfidence}.`,
    };
  }

  // Solve for the highest all-in acquisition cost that still clears BOTH
  // the absolute profit floor and the ROC floor against this QSV:
  //     netCash - acquisition >= minNetProfit  =>  acquisition <= netCash - minNetProfit
  //     netCash - acquisition >= acquisition * minROC
  //                                            =>  acquisition <= netCash / (1 + minROC)
  const sale = computeNetSaleProceeds({ itemPrice: qsv }, feeModel, sellingCosts);
  const capFromProfit = sale.netProceeds - qualification.minNetProfit;
  const capFromRoc = sale.netProceeds / (1 + qualification.minReturnOnCapital);
  const maxProfitableAcquisitionPrice = round2(Math.max(0, Math.min(capFromProfit, capFromRoc)));

  // MWMC V1 FINAL SHIP PASS item 4/6/7: a SECOND, broader ceiling — the
  // highest acquisition price at which the trade is exactly break-even (£0
  // profit / 0% ROC; both constraints coincide at zero, so one figure covers
  // both) against this card's own QSV and real exit costs. This is what
  // bounds DISCOVERY — eligibility for the Dynamic Flip Universe, and (via
  // marketProfilesRepo.ts's listEligibleUniverseCards) the eBay search price
  // filter in scanRunner.ts. maxProfitableAcquisitionPrice above stays a
  // "headroom vs. the live qualification bar" reference only, still used for
  // flipMarketScore below — it must never again be what decides whether a
  // listing gets fetched from eBay at all, or this card would be silently
  // invisible to any manual filter looser than the persisted bar. Always
  // >= maxProfitableAcquisitionPrice, since removing the profit/ROC floor
  // can only relax the ceiling, never tighten it.
  const discoveryMaxAcquisitionPrice = round2(Math.max(0, sale.netProceeds));

  if (discoveryMaxAcquisitionPrice <= 0) {
    return {
      ...base,
      maxProfitableAcquisitionPrice: 0,
      discoveryMaxAcquisitionPrice: 0,
      ineligibleReason: `No acquisition price — even £0 — is profitable at a QSV of £${qsv} once fees and fulfilment are deducted.`,
    };
  }

  // Whether this card clears the LIVE qualification bar at any price — a
  // card can be a genuine, discoverable candidate (discoveryMaxAcquisitionPrice
  // > 0) without ever clearing the bar itself, e.g. a low-value card whose
  // best-case profit tops out at £25 against a £40 minimum. That candidate
  // must still be searched for and persisted (as WATCH) — see the doc
  // comment above — it just never gets a bar-relative reference score.
  const clearsQualificationBar = maxProfitableAcquisitionPrice > 0;

  // Reference score for prioritisation only: prices the acquisition exactly
  // at the qualification-bar ceiling, so the resulting ROC sits on the
  // qualification boundary. NOT a claim about achievable profit for any real
  // listing. Null (never a fabricated or divide-by-zero score) when the card
  // doesn't clear the bar at any price — rankForEbaySearch's `(card.score ??
  // 0)` fallback still ranks it, just without a bar-relative signal.
  const referenceNetProfit = clearsQualificationBar ? round2(sale.netProceeds - maxProfitableAcquisitionPrice) : null;

  return {
    ...base,
    eligible: true,
    maxProfitableAcquisitionPrice,
    discoveryMaxAcquisitionPrice,
    flipMarketScore:
      referenceNetProfit === null
        ? null
        : computeFlipScore({
            returnOnCapital: referenceNetProfit / maxProfitableAcquisitionPrice,
            netProfit: referenceNetProfit,
            liquidity: snapshot.liquidity,
            confidence: qsvResult.confidence,
            listingQuality: 0.5, // unknown until a real listing exists — neutral placeholder
            weights: flipScoreWeights,
          }).score,
  };
}
