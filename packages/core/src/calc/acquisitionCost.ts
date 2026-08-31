import type { AcquisitionInput, TotalAcquisitionCost } from "./types.js";
import { round2 } from "./fees.js";

/**
 * TOTAL ACQUISITION =
 *     listing item price
 *   + seller postage
 *   + buyer/import tax if applicable
 *   + other explicit acquisition cost
 *
 * This is the capital actually deployed, and the denominator for RETURN ON
 * ACQUISITION CAPITAL.
 */
export function computeAcquisitionCost(input: AcquisitionInput): TotalAcquisitionCost {
  const { purchasePrice, sellerPostage } = input;
  const importTax = input.importTax ?? 0;
  const acquisitionFees = input.acquisitionFees ?? 0;

  if (purchasePrice < 0 || sellerPostage < 0 || importTax < 0 || acquisitionFees < 0) {
    throw new Error("computeAcquisitionCost: all cost inputs must be >= 0");
  }

  return {
    purchasePrice: round2(purchasePrice),
    sellerPostage: round2(sellerPostage),
    importTax: round2(importTax),
    acquisitionFees: round2(acquisitionFees),
    total: round2(purchasePrice + sellerPostage + importTax + acquisitionFees),
  };
}

export { round2 } from "./fees.js";
