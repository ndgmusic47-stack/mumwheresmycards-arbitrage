import type { ExitMarketFeeModel, SellingFeeBreakdown } from "./fees.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL, computeSellingFees, round2 } from "./fees.js";
import type { SellingCostSettings } from "./types.js";
import { DEFAULT_SELLING_COSTS } from "./types.js";

export interface SaleInput {
  /** The item's selling price — QSV for a raw flip, slab market value for a graded exit. */
  itemPrice: number;
  /** Postage the BUYER pays on top of the item price. Part of the fee base. */
  buyerPaidShipping?: number;
  /** Our own outbound postage cost. */
  outboundPostage?: number;
  insurance?: number;
  packaging?: number;
  feeOverrides?: Partial<ExitMarketFeeModel>;
}

export interface NetSaleProceeds {
  itemPrice: number;
  buyerPaidShipping: number;
  /** item price + buyer-paid shipping — the gross cash the buyer sends. */
  buyerPayment: number;
  fees: SellingFeeBreakdown;
  outboundPostage: number;
  insurance: number;
  packaging: number;
  totalDeductions: number;
  /** NET SALE CASH — what actually lands in the bank after everything. */
  netProceeds: number;
}

/**
 * NET SALE CASH =
 *     buyer payment (item price + buyer-paid shipping)
 *   - marketplace selling fees (incl. non-recoverable VAT on those fees)
 *   - outbound postage
 *   - insurance
 *   - packaging
 *
 * Applies identically to a raw flip exit and a graded slab exit — the only
 * difference is what `itemPrice` is (QSV vs slab market value) and which
 * postage/insurance defaults are appropriate for the item being shipped.
 */
export function computeNetSaleProceeds(
  input: SaleInput,
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
  sellingCosts: SellingCostSettings = DEFAULT_SELLING_COSTS,
): NetSaleProceeds {
  if (input.itemPrice < 0) {
    throw new Error("computeNetSaleProceeds: itemPrice must be >= 0");
  }

  const effectiveFeeModel: ExitMarketFeeModel = { ...feeModel, ...input.feeOverrides };
  const buyerPaidShipping = input.buyerPaidShipping ?? 0;

  const fees = computeSellingFees({ itemPrice: input.itemPrice, buyerPaidShipping }, effectiveFeeModel);

  const outboundPostage = input.outboundPostage ?? sellingCosts.outboundPostage;
  const insurance = input.insurance ?? sellingCosts.saleInsurance;
  const packaging = input.packaging ?? sellingCosts.packaging;

  const totalDeductions = round2(fees.totalSellingFees + outboundPostage + insurance + packaging);
  const netProceeds = round2(fees.buyerPayment - totalDeductions);

  return {
    itemPrice: round2(input.itemPrice),
    buyerPaidShipping: round2(buyerPaidShipping),
    buyerPayment: fees.buyerPayment,
    fees,
    outboundPostage: round2(outboundPostage),
    insurance: round2(insurance),
    packaging: round2(packaging),
    totalDeductions,
    netProceeds,
  };
}
