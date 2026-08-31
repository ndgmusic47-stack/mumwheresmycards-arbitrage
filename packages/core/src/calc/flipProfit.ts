import type { FlipProfitResult } from "./types.js";
import { round2, round4 } from "./fees.js";

/**
 * RAW FLIP ECONOMICS.
 *
 *   TRUE NET PROFIT = net sale cash - total acquisition
 *   ROC             = true net profit / total acquisition
 *   PROFIT MARGIN   = true net profit / buyer payment (revenue)
 *
 * Margin is expressed against REVENUE (what the buyer pays), not against
 * net-of-fees proceeds, so ROC and margin don't double-count the same fee
 * deduction in two different denominators.
 */
export function computeFlipProfit(params: {
  totalAcquisitionCost: number;
  netSaleProceeds: number;
  /** Buyer payment (item + buyer-paid shipping) — the revenue line. */
  buyerPayment: number;
  /** Estimated days from purchase to completed sale, for velocity metrics. */
  expectedDaysToSale?: number | null;
}): FlipProfitResult {
  const { totalAcquisitionCost, netSaleProceeds, buyerPayment } = params;

  if (totalAcquisitionCost <= 0) {
    throw new Error("computeFlipProfit: totalAcquisitionCost must be > 0");
  }
  if (buyerPayment < 0) {
    throw new Error("computeFlipProfit: buyerPayment must be >= 0");
  }

  const netProfit = round2(netSaleProceeds - totalAcquisitionCost);
  const returnOnCapital = round4(netProfit / totalAcquisitionCost);

  return {
    totalAcquisitionCost: round2(totalAcquisitionCost),
    netSaleProceeds: round2(netSaleProceeds),
    netProfit,
    returnOnCapital,
    profitMargin: buyerPayment > 0 ? round4(netProfit / buyerPayment) : 0,
    expectedDaysToSale: params.expectedDaysToSale ?? null,
    // Profit per £ of capital is ROC restated — surfaced as its own field
    // because the dashboard shows it directly alongside absolute profit,
    // and the two answer different questions ("how much" vs "how hard is
    // this pound working").
    profitPerPoundOfCapital: returnOnCapital,
  };
}
