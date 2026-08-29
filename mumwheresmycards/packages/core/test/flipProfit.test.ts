import { describe, it, expect } from "vitest";
import { computeFlipProfit } from "../src/calc/flipProfit.js";
import { computeAcquisitionCost } from "../src/calc/acquisitionCost.js";
import { computeNetSaleProceeds } from "../src/calc/netSaleProceeds.js";

describe("computeFlipProfit", () => {
  it("computes net profit, ROC and profit margin end-to-end", () => {
    const acquisition = computeAcquisitionCost({ purchasePrice: 60, sellerPostage: 4 }); // total 64
    const sale = computeNetSaleProceeds({ salePrice: 120, outboundPostage: 4.5, packaging: 1.5 });

    const result = computeFlipProfit({
      totalAcquisitionCost: acquisition.total,
      netSaleProceeds: sale.netProceeds,
      grossSalePrice: 120,
    });

    expect(result.netProfit).toBeCloseTo(sale.netProceeds - 64, 2);
    expect(result.returnOnCapital).toBeCloseTo(result.netProfit / 64, 4);
    expect(result.profitMargin).toBeCloseTo(result.netProfit / 120, 4);
  });

  it("produces a negative net profit and negative ROC for an overpriced buy", () => {
    const result = computeFlipProfit({ totalAcquisitionCost: 100, netSaleProceeds: 80, grossSalePrice: 90 });
    expect(result.netProfit).toBe(-20);
    expect(result.returnOnCapital).toBe(-0.2);
  });

  it("returns 0 profit margin when gross sale price is 0", () => {
    const result = computeFlipProfit({ totalAcquisitionCost: 10, netSaleProceeds: -10, grossSalePrice: 0 });
    expect(result.profitMargin).toBe(0);
  });

  it("throws when totalAcquisitionCost is zero or negative (division by zero guard for ROC)", () => {
    expect(() => computeFlipProfit({ totalAcquisitionCost: 0, netSaleProceeds: 10, grossSalePrice: 10 })).toThrow();
    expect(() => computeFlipProfit({ totalAcquisitionCost: -5, netSaleProceeds: 10, grossSalePrice: 10 })).toThrow();
  });
});
