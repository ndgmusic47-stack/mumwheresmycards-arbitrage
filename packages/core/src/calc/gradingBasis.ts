import type { GradedBasisInput, GradingBatchSettings, GradingConsumables, TotalGradedBasis } from "./types.js";
import { DEFAULT_GRADING_BATCH, DEFAULT_GRADING_CONSUMABLES } from "./types.js";
import { round2 } from "./fees.js";

/**
 * TOTAL GRADED BASIS = every pound committed to get one graded slab ready
 * to sell:
 *
 *     raw purchase price
 *   + seller postage
 *   + import tax / other acquisition fees
 *   + grading service fee for the SELECTED service tier
 *   + per-card share of BATCH logistics
 *   + per-card consumables (sleeve, Card Saver)
 *   + declared-value upcharge reserve, only where one is carried
 *
 * The batch allocation is the important correction. Grading submissions go
 * out in batches (10 cards by default), so postage and insurance to and
 * from the grader are shared. Charging the full batch postage to every
 * single card — which this project previously did at £8 out + £7 back per
 * card — inflates the basis by roughly £32/card at a batch size of 10, and
 * that inflation lands directly on the profit line at every grade.
 */
export function computeGradedBasis(input: GradedBasisInput): TotalGradedBasis {
  const batch: GradingBatchSettings = input.batch ?? DEFAULT_GRADING_BATCH;
  const consumables: GradingConsumables = input.consumables ?? DEFAULT_GRADING_CONSUMABLES;

  if (input.rawPurchasePrice < 0 || input.sellerPostage < 0) {
    throw new Error("computeGradedBasis: cost inputs must be >= 0");
  }
  if (batch.batchSize < 1) {
    throw new Error("computeGradedBasis: batchSize must be >= 1");
  }

  const importTax = input.importTax ?? 0;
  const acquisitionFees = input.acquisitionFees ?? 0;
  const upchargeReserve = input.upchargeReserve ?? 0;

  const perCardSharedLogistics = round2(
    (batch.batchOutboundPostage + batch.batchReturnPostage + batch.batchInsurance) / batch.batchSize,
  );

  const total = round2(
    input.rawPurchasePrice +
      input.sellerPostage +
      importTax +
      acquisitionFees +
      input.service.feePerCard +
      perCardSharedLogistics +
      consumables.sleeveCost +
      consumables.cardSaverCost +
      upchargeReserve,
  );

  return {
    rawPurchasePrice: round2(input.rawPurchasePrice),
    sellerPostage: round2(input.sellerPostage),
    importTax: round2(importTax),
    acquisitionFees: round2(acquisitionFees),
    gradingFee: round2(input.service.feePerCard),
    perCardSharedLogistics,
    sleeve: round2(consumables.sleeveCost),
    cardSaver: round2(consumables.cardSaverCost),
    upchargeReserve: round2(upchargeReserve),
    total,
    serviceId: input.service.id,
    batchSize: batch.batchSize,
  };
}
