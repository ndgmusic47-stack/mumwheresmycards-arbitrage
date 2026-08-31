/**
 * EBAY UK BUSINESS SELLER COST MODEL (V1 exit market).
 *
 * V1 assumes BOTH raw flips and graded-card exits are sold through an eBay
 * UK business seller account. The exit provider is modelled as data (see
 * `ExitMarketFeeModel`) so Cardmarket/Packrat/shows can be added later
 * without touching calculation code — but no alternate exit is modelled
 * yet, deliberately.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the old fee schedule: the previous
 * model carried three wrong assumptions at once — a 13.25% final value fee,
 * a £0.30 fixed order fee, and a `paymentProcessingPct` field that does not
 * correspond to any real eBay UK business charge (managed payments are
 * bundled into the final value fee). It also omitted the regulatory
 * operating fee and VAT on seller fees entirely.
 *
 * VAT TREATMENT — the subtle one. eBay publishes UK business seller fees
 * EXCLUSIVE of VAT, then charges 20% VAT on top of those fees. Whether that
 * VAT is a real economic cost depends on the seller's own VAT position:
 *   - Not VAT registered (or unable to reclaim): the VAT is a true cost.
 *   - VAT registered and reclaiming input VAT: it washes out.
 * `sellerFeeVatRecoverable` decides which, and defaults to FALSE — the
 * conservative assumption that overstates cost rather than flattering
 * profit. This is VAT on the SELLER FEES only. It is deliberately NOT any
 * statement about VAT on the card sale itself (margin scheme, second-hand
 * goods treatment, etc.), which this project does not model.
 */

export interface ExitMarketFeeModel {
  /** Variable final value fee, as a fraction of the buyer's total payment. */
  finalValueFeePct: number;
  /** Regulatory operating fee, as a fraction of the buyer's total payment. */
  regulatoryOperatingFeePct: number;
  /** Flat per-order fee charged on orders ABOVE `perOrderFeeThreshold`. */
  perOrderFee: number;
  /** Order value above which `perOrderFee` applies. */
  perOrderFeeThreshold: number;
  /**
   * Flat per-order fee at or below the threshold. The published reference
   * this model was built from only specifies the ABOVE-£10 fee, so this
   * defaults to the same £0.40 rather than a guessed lower number —
   * deliberately conservative (never understates cost) and configurable.
   * It is not a claim about eBay's actual sub-£10 charge.
   */
  perOrderFeeBelowThreshold: number;
  /** Promoted Listings ad rate. Default 0 — opt-in per listing, not assumed. */
  promotedListingsPct: number;
  /** International selling fee. Default 0 — V1 assumes a UK buyer, UK exit. */
  internationalFeePct: number;
  /** VAT rate applied by the marketplace ON TOP of its (VAT-exclusive) fees. */
  feeVatRate: number;
  /**
   * TRUE if the seller reclaims the VAT charged on marketplace fees, making
   * it economically neutral. FALSE (default) treats it as a real cost.
   */
  sellerFeeVatRecoverable: boolean;
}

/**
 * Current UK business seller reference assumptions. Every value here is a
 * commercial assumption that belongs in Settings, not in code — these are
 * only the seed defaults (see migration 0013 / `settings.exit_market_fees`).
 */
export const DEFAULT_EXIT_MARKET_FEE_MODEL: ExitMarketFeeModel = {
  finalValueFeePct: 0.109,
  regulatoryOperatingFeePct: 0.0035,
  perOrderFee: 0.4,
  perOrderFeeThreshold: 10,
  perOrderFeeBelowThreshold: 0.4,
  promotedListingsPct: 0,
  internationalFeePct: 0,
  feeVatRate: 0.2,
  sellerFeeVatRecoverable: false,
};

export interface SellingFeeBreakdown {
  /** What the buyer pays in total — the base every percentage fee is charged on. */
  buyerPayment: number;
  finalValueFee: number;
  regulatoryOperatingFee: number;
  perOrderFee: number;
  promotedListingsFee: number;
  internationalFee: number;
  /** Sum of the above, VAT-exclusive, as eBay publishes them. */
  feesExVat: number;
  /** VAT charged on those fees at `feeVatRate`. */
  feeVat: number;
  /** The portion of `feeVat` that is a real economic cost (0 if recoverable). */
  nonRecoverableFeeVat: number;
  /** feesExVat + nonRecoverableFeeVat — what actually leaves the business. */
  totalSellingFees: number;
}

/**
 * Marketplace selling fees on one order.
 *
 * The fee base is the BUYER'S TOTAL PAYMENT (item price + any buyer-paid
 * postage), not the item price alone — eBay charges its variable fees on
 * the full amount of the sale including postage, so charging them on the
 * item price alone would systematically understate cost on every listing
 * that charges postage.
 */
export function computeSellingFees(
  params: { itemPrice: number; buyerPaidShipping?: number },
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
): SellingFeeBreakdown {
  if (params.itemPrice < 0) throw new Error("computeSellingFees: itemPrice must be >= 0");
  const buyerPaidShipping = params.buyerPaidShipping ?? 0;
  if (buyerPaidShipping < 0) throw new Error("computeSellingFees: buyerPaidShipping must be >= 0");

  const buyerPayment = round2(params.itemPrice + buyerPaidShipping);

  const finalValueFee = round2(buyerPayment * feeModel.finalValueFeePct);
  const regulatoryOperatingFee = round2(buyerPayment * feeModel.regulatoryOperatingFeePct);
  const perOrderFee =
    buyerPayment > feeModel.perOrderFeeThreshold ? feeModel.perOrderFee : feeModel.perOrderFeeBelowThreshold;
  const promotedListingsFee = round2(buyerPayment * feeModel.promotedListingsPct);
  const internationalFee = round2(buyerPayment * feeModel.internationalFeePct);

  const feesExVat = round2(
    finalValueFee + regulatoryOperatingFee + perOrderFee + promotedListingsFee + internationalFee,
  );
  const feeVat = round2(feesExVat * feeModel.feeVatRate);
  const nonRecoverableFeeVat = feeModel.sellerFeeVatRecoverable ? 0 : feeVat;
  const totalSellingFees = round2(feesExVat + nonRecoverableFeeVat);

  return {
    buyerPayment,
    finalValueFee,
    regulatoryOperatingFee,
    perOrderFee: round2(perOrderFee),
    promotedListingsFee,
    internationalFee,
    feesExVat,
    feeVat,
    nonRecoverableFeeVat,
    totalSellingFees,
  };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
