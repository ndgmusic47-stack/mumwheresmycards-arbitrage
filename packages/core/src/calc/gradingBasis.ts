import type { FeeSchedule, GradingBasisInput, TotalGradedBasis } from "./types.js";
import { DEFAULT_FEE_SCHEDULE } from "./types.js";
import { round2 } from "./acquisitionCost.js";

/**
 * TOTAL GRADED BASIS = raw purchase
 *   + seller postage
 *   + packaging
 *   + sleeve
 *   + Card Saver
 *   + insured grading postage allocation
 *   + PSA/intermediary grading fee
 *   + return shipping
 *   + insurance
 *   + PSA upcharge reserve (only where applicable)
 */
export function computeGradingBasis(input: GradingBasisInput, feeSchedule: FeeSchedule = DEFAULT_FEE_SCHEDULE): TotalGradedBasis {
  if (input.rawPurchasePrice < 0 || input.sellerPostage < 0 || input.returnShipping < 0 || input.insurance < 0) {
    throw new Error("computeGradingBasis: cost inputs must be >= 0");
  }

  const packaging = input.packaging ?? input.fees?.packagingDefault ?? feeSchedule.packagingDefault;
  const sleeve = input.sleeve ?? input.fees?.sleeveCost ?? feeSchedule.sleeveCost;
  const cardSaver = input.cardSaver ?? input.fees?.cardSaverCost ?? feeSchedule.cardSaverCost;
  const insuredGradingPostageAllocation =
    input.insuredGradingPostageAllocation ?? input.fees?.insuredPostageAllocation ?? feeSchedule.insuredPostageAllocation;
  const gradingFee = input.gradingFee ?? input.fees?.gradingFeePsaRegular ?? feeSchedule.gradingFeePsaRegular;
  const upchargeReserve = input.upchargeReserveApplies
    ? input.fees?.gradingUpchargeReserve ?? feeSchedule.gradingUpchargeReserve
    : 0;

  const total = round2(
    input.rawPurchasePrice +
      input.sellerPostage +
      packaging +
      sleeve +
      cardSaver +
      insuredGradingPostageAllocation +
      gradingFee +
      input.returnShipping +
      input.insurance +
      upchargeReserve,
  );

  return {
    rawPurchasePrice: round2(input.rawPurchasePrice),
    sellerPostage: round2(input.sellerPostage),
    packaging: round2(packaging),
    sleeve: round2(sleeve),
    cardSaver: round2(cardSaver),
    insuredGradingPostageAllocation: round2(insuredGradingPostageAllocation),
    gradingFee: round2(gradingFee),
    returnShipping: round2(input.returnShipping),
    insurance: round2(input.insurance),
    upchargeReserve: round2(upchargeReserve),
    total,
  };
}
