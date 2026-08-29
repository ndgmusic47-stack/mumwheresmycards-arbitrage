import type { FlipProfitResult } from "./types.js";
import { round2 } from "./acquisitionCost.js";

/**
 * EXPECTED NET PROFIT = expected net sale proceeds - total acquisition cost
 * RETURN ON CAPITAL = expected net profit / total acquisition cost
 * PROFIT MARGIN = expected net profit / gross sale price (QSV)
 *
 * grossSalePrice is passed separately from netSaleProceeds because "margin"
 * is conventionally expressed against revenue, not against net-of-fees
 * proceeds — keeps ROC and margin from double-counting the same fee
 * deduction in different denominators.
 */
export function computeFlipProfit(params: {
  totalAcquisitionCost: number;
  netSaleProceeds: number;
  grossSalePrice: number;
}): FlipProfitResult {
  const { totalAcquisitionCost, netSaleProceeds, grossSalePrice } = params;

  if (totalAcquisitionCost <= 0) {
    throw new Error("computeFlipProfit: totalAcquisitionCost must be > 0");
  }
  if (grossSalePrice < 0) {
    throw new Error("computeFlipProfit: grossSalePrice must be >= 0");
  }

  const netProfit = round2(netSaleProceeds - totalAcquisitionCost);
  const returnOnCapital = round4(netProfit / totalAcquisitionCost);
  const profitMargin = grossSalePrice > 0 ? round4(netProfit / grossSalePrice) : 0;

  return {
    totalAcquisitionCost: round2(totalAcquisitionCost),
    netSaleProceeds: round2(netSaleProceeds),
    netProfit,
    returnOnCapital,
    profitMargin,
  };
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
