import { describe, it, expect } from "vitest";
import { computeAcquisitionCost, computeFlipProfit, computeNetSaleProceeds } from "../src/index.js";

describe("computeAcquisitionCost", () => {
  it("sums item price, seller postage, import tax and other acquisition costs", () => {
    const result = computeAcquisitionCost({
      purchasePrice: 100,
      sellerPostage: 3.5,
      importTax: 12,
      acquisitionFees: 1.5,
    });
    expect(result.total).toBeCloseTo(117, 2);
  });

  it("treats missing tax and fees as zero, not as unknown", () => {
    expect(computeAcquisitionCost({ purchasePrice: 50, sellerPostage: 2 }).total).toBeCloseTo(52, 2);
  });

  it("rejects negative inputs", () => {
    expect(() => computeAcquisitionCost({ purchasePrice: -1, sellerPostage: 0 })).toThrow();
  });
});

describe("computeFlipProfit — true net profit and ROC", () => {
  it("computes profit as net sale cash minus total acquisition", () => {
    const result = computeFlipProfit({
      totalAcquisitionCost: 100,
      netSaleProceeds: 175,
      buyerPayment: 200,
    });
    expect(result.netProfit).toBeCloseTo(75, 2);
  });

  it("computes ROC against deployed capital", () => {
    const result = computeFlipProfit({
      totalAcquisitionCost: 100,
      netSaleProceeds: 175,
      buyerPayment: 200,
    });
    expect(result.returnOnCapital).toBeCloseTo(0.75, 4);
  });

  it("computes margin against revenue, not against net proceeds", () => {
    const result = computeFlipProfit({
      totalAcquisitionCost: 100,
      netSaleProceeds: 175,
      buyerPayment: 200,
    });
    // 75 / 200 (revenue), not 75 / 175 (proceeds).
    expect(result.profitMargin).toBeCloseTo(0.375, 4);
  });

  it("surfaces profit per £ of capital alongside absolute profit", () => {
    const result = computeFlipProfit({
      totalAcquisitionCost: 200,
      netSaleProceeds: 300,
      buyerPayment: 350,
    });
    expect(result.profitPerPoundOfCapital).toBeCloseTo(result.returnOnCapital, 4);
  });

  it("carries the expected capital-lock estimate through", () => {
    const result = computeFlipProfit({
      totalAcquisitionCost: 100,
      netSaleProceeds: 175,
      buyerPayment: 200,
      expectedDaysToSale: 14,
    });
    expect(result.expectedDaysToSale).toBe(14);
  });

  it("reports a loss honestly rather than flooring at zero", () => {
    const result = computeFlipProfit({
      totalAcquisitionCost: 200,
      netSaleProceeds: 150,
      buyerPayment: 180,
    });
    expect(result.netProfit).toBeCloseTo(-50, 2);
    expect(result.returnOnCapital).toBeLessThan(0);
  });

  it("rejects zero deployed capital rather than dividing by zero", () => {
    expect(() =>
      computeFlipProfit({ totalAcquisitionCost: 0, netSaleProceeds: 100, buyerPayment: 120 }),
    ).toThrow();
  });

  it("produces the full worked example end to end", () => {
    // Buy at £100 + £3 postage; sell at a £200 QSV.
    const acquisition = computeAcquisitionCost({ purchasePrice: 100, sellerPostage: 3 });
    const sale = computeNetSaleProceeds({ itemPrice: 200 });
    const profit = computeFlipProfit({
      totalAcquisitionCost: acquisition.total,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
    });

    //   FVF          200 * 0.109  = 21.80
    //   regulatory   200 * 0.0035 =  0.70
    //   per order                 =  0.40
    //   ex-VAT                    = 22.90
    //   +20% fee VAT              = 27.48
    //   fulfilment: 1.55 postage + 0.75 packaging = 2.30
    //   net cash:   200 - 27.48 - 2.30            = 170.22
    //   profit:     170.22 - 103                  =  67.22
    expect(sale.fees.feesExVat).toBeCloseTo(22.9, 2);
    expect(sale.fees.totalSellingFees).toBeCloseTo(27.48, 2);
    expect(sale.netProceeds).toBeCloseTo(170.22, 2);
    expect(profit.netProfit).toBeCloseTo(67.22, 2);
    expect(profit.returnOnCapital).toBeCloseTo(0.6526, 3);
  });
});
