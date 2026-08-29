import type { FeeSchedule, NetSaleProceeds, SaleInput } from "./types.js";
import { DEFAULT_FEE_SCHEDULE } from "./types.js";
import { round2 } from "./acquisitionCost.js";

/**
 * EXPECTED NET SALE PROCEEDS = sale price
 *   - marketplace fees
 *   - payment costs
 *   - outbound postage
 *   - insurance
 *   - packaging
 */
export function computeNetSaleProceeds(input: SaleInput, feeSchedule: FeeSchedule = DEFAULT_FEE_SCHEDULE): NetSaleProceeds {
  if (input.salePrice < 0) {
    throw new Error("computeNetSaleProceeds: salePrice must be >= 0");
  }

  const finalValueFeePct = input.fees?.ebayFinalValueFeePct ?? feeSchedule.ebayFinalValueFeePct;
  const fixedFee = input.fees?.ebayFixedFeePerOrder ?? feeSchedule.ebayFixedFeePerOrder;
  const paymentProcessingPct = input.fees?.paymentProcessingPct ?? feeSchedule.paymentProcessingPct;

  const outboundPostage = input.outboundPostage ?? feeSchedule.outboundPostageDefault;
  const insurance = input.insurance ?? 0;
  const packaging = input.packaging ?? feeSchedule.packagingDefault;

  const marketplaceFee = round2(input.salePrice * finalValueFeePct);
  const paymentProcessingFee = round2(input.salePrice * paymentProcessingPct);

  const totalDeductions = round2(marketplaceFee + fixedFee + paymentProcessingFee + outboundPostage + insurance + packaging);

  const netProceeds = round2(input.salePrice - totalDeductions);

  return {
    salePrice: input.salePrice,
    marketplaceFee,
    fixedFee: round2(fixedFee),
    paymentProcessingFee,
    outboundPostage: round2(outboundPostage),
    insurance: round2(insurance),
    packaging: round2(packaging),
    totalDeductions,
    netProceeds,
  };
}
