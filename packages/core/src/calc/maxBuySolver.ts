import type { ExitMarketFeeModel } from "./fees.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL, round2 } from "./fees.js";
import type { GradingBatchSettings, GradingConsumables, GradingService, PsaGrade, SellingCostSettings } from "./types.js";
import { DEFAULT_GRADING_BATCH, DEFAULT_GRADING_CONSUMABLES, DEFAULT_SELLING_COSTS } from "./types.js";
import { computeNetSaleProceeds } from "./netSaleProceeds.js";

/**
 * AI INTELLIGENCE spec item 14: reverse max-buy solver.
 *
 * FLIP already has TWO forward-solved ceilings — market/flipProfile.ts's
 * `maxProfitableAcquisitionPrice` (card-level, against QSV) and
 * calc/maxBid.ts's `computeMaxBid` (listing-level, against an actual
 * listing's own sale-side economics). GRADE had NEITHER: maxBid.ts's own
 * doc comment explicitly punts on it ("solving an equivalent ceiling for
 * GRADE would need real new design work, not a one-line reuse of this
 * formula"). This file is that work.
 *
 * SCOPE: GRADE qualifies via a multi-branch economic-class predicate
 * (../grading/classification.ts), not a single linear inequality — there
 * is no one universal "max buy" that covers every classification branch at
 * once (an ASYMMETRIC card, for instance, qualifies on its PSA10 upside
 * despite losing money at lower grades, which a single linear ceiling
 * cannot represent). Rather than fabricate a false single answer, this
 * solves the same well-defined question flipProfile.ts and maxBid.ts both
 * ask, applied to ONE NAMED REFERENCE GRADE at a time: "what's the highest
 * raw purchase price I could pay and still clear the profit/ROC bar IF
 * this card grades at exactly this grade?" — called once per grade of
 * interest (typically PSA 9, the same VELOCITY_REFERENCE_GRADE convention
 * ../grading/serviceComparison.ts already uses for capital-velocity
 * comparisons), never presented as a probability-weighted blend across
 * grades.
 */
export interface MaxRawPriceForGradingInput {
  /** Gross slab market value at the target grade, in GBP. Required — pass
   *  null upstream (never 0) if this grade's slab value is unknown; the
   *  solver refuses rather than dividing against a fabricated reference. */
  slabValueAtGrade: number;
  service: GradingService;
  minNetProfit: number;
  minReturnOnCapital: number;
  /** Non-purchase-price acquisition-side costs already known for this
   *  listing (seller postage, import tax, other acquisition fees) — these
   *  add to the ceiling's fixed-cost side exactly as they do in
   *  computeGradedBasis. Defaults to 0 each, matching that function's own
   *  defaults. */
  sellerPostage?: number;
  importTax?: number;
  acquisitionFees?: number;
  batch?: GradingBatchSettings;
  consumables?: GradingConsumables;
  /** A known declared-value upcharge reserve to hold constant, if this
   *  grade is expected to trip the service's declared-value cap. Omitted
   *  (0) means "assume no upcharge" — the same assumption computeGradedBasis
   *  makes when none is supplied. */
  upchargeReserve?: number;
  feeModel?: ExitMarketFeeModel;
  sellingCosts?: SellingCostSettings;
}

export interface MaxRawPriceForGradingResult {
  /** The highest RAW PURCHASE PRICE (before postage/tax/fees/grading costs)
   *  that would still clear both the profit and ROC bars at the target
   *  grade — null when the reference slab value itself can't support any
   *  positive raw price (fixed costs alone already exceed what the grade
   *  can profitably absorb). Never negative. */
  maxRawPurchasePrice: number | null;
  /** maxRawPurchasePrice's counterpart in total-graded-basis terms — every
   *  pound committed (raw price + postage/tax/fees + grading service fee +
   *  batch share + consumables + upcharge reserve), same definition as
   *  computeGradedBasis's `total`. */
  maxTotalGradedBasis: number | null;
  /** The fixed, price-independent side of the graded basis this solve held
   *  constant — grading fee, batch share, consumables, postage/tax/fees,
   *  upcharge reserve. Surfaced so the caller can see exactly what was
   *  assumed rather than trusting a black box. */
  fixedCostsHeldConstant: number;
  /** Which of the profit floor or ROC floor was the binding constraint —
   *  "PROFIT" or "ROC", or null when neither could be evaluated. Mirrors
   *  the same two-cap-then-take-the-lower technique flipProfile.ts and
   *  maxBid.ts both use; this field is what makes that arithmetic visible
   *  rather than opaque. */
  bindingConstraint: "PROFIT" | "ROC" | null;
}

export function computeMaxRawPriceForGrading(input: MaxRawPriceForGradingInput): MaxRawPriceForGradingResult {
  if (input.slabValueAtGrade <= 0) {
    return { maxRawPurchasePrice: null, maxTotalGradedBasis: null, fixedCostsHeldConstant: 0, bindingConstraint: null };
  }

  const batch = input.batch ?? DEFAULT_GRADING_BATCH;
  const consumables = input.consumables ?? DEFAULT_GRADING_CONSUMABLES;
  const sellingCosts = input.sellingCosts ?? DEFAULT_SELLING_COSTS;
  const feeModel = input.feeModel ?? DEFAULT_EXIT_MARKET_FEE_MODEL;

  // Net sale proceeds at the target grade — independent of acquisition
  // cost, exactly like flipProfile.ts's QSV-side proceeds. Uses the graded
  // (not raw) selling-cost defaults, same as computeGradeLadder does.
  const sale = computeNetSaleProceeds(
    { itemPrice: input.slabValueAtGrade, outboundPostage: sellingCosts.outboundPostageGraded, insurance: sellingCosts.saleInsuranceGraded, packaging: sellingCosts.packaging },
    feeModel,
  );

  // Every graded-basis component that does NOT scale with raw purchase
  // price — see computeGradedBasis's own breakdown for the exact same list.
  const perCardSharedLogistics = round2((batch.batchOutboundPostage + batch.batchReturnPostage + batch.batchInsurance) / batch.batchSize);
  const fixedCostsHeldConstant = round2(
    (input.sellerPostage ?? 0) +
      (input.importTax ?? 0) +
      (input.acquisitionFees ?? 0) +
      input.service.feePerCard +
      perCardSharedLogistics +
      consumables.sleeveCost +
      consumables.cardSaverCost +
      (input.upchargeReserve ?? 0),
  );

  // Same derivation as maxBid.ts/flipProfile.ts, applied to totalGradedBasis
  // in place of totalAcquisitionCost:
  //   netProceeds - basis >= minNetProfit  =>  basis <= netProceeds - minNetProfit
  //   (netProceeds - basis) / basis >= minROC  =>  basis <= netProceeds / (1 + minROC)
  const capFromProfit = sale.netProceeds - input.minNetProfit;
  const capFromRoc = sale.netProceeds / (1 + input.minReturnOnCapital);
  const maxTotalGradedBasis = Math.max(0, Math.min(capFromProfit, capFromRoc));
  const bindingConstraint: "PROFIT" | "ROC" = capFromProfit <= capFromRoc ? "PROFIT" : "ROC";

  const maxRawPurchasePrice = Math.max(0, maxTotalGradedBasis - fixedCostsHeldConstant);

  return {
    maxRawPurchasePrice: round2(maxRawPurchasePrice),
    maxTotalGradedBasis: round2(maxTotalGradedBasis),
    fixedCostsHeldConstant,
    bindingConstraint,
  };
}

/** Convenience re-export of the reference grade convention used elsewhere
 *  in the grading pipeline, so a caller solving "the" max buy for a card
 *  (rather than a specific named grade) has one obvious default to reach
 *  for — see ../grading/serviceComparison.ts's VELOCITY_REFERENCE_GRADE,
 *  which this intentionally mirrors rather than redefines. */
export const DEFAULT_MAX_BUY_REFERENCE_GRADE: PsaGrade = 9;
