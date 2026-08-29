import type { AcquisitionInput, TotalAcquisitionCost } from "./types.js";

/**
 * TOTAL ACQUISITION COST = purchase price + seller postage + applicable
 * taxes/import cost + acquisition costs.
 */
export function computeAcquisitionCost(input: AcquisitionInput): TotalAcquisitionCost {
  const { purchasePrice, sellerPostage } = input;
  const importTax = input.importTax ?? 0;
  const acquisitionFees = input.acquisitionFees ?? 0;

  if (purchasePrice < 0 || sellerPostage < 0 || importTax < 0 || acquisitionFees < 0) {
    throw new Error("computeAcquisitionCost: all cost inputs must be >= 0");
  }

  const total = purchasePrice + sellerPostage + importTax + acquisitionFees;

  return {
    purchasePrice,
    sellerPostage,
    importTax,
    acquisitionFees,
    total: round2(total),
  };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
