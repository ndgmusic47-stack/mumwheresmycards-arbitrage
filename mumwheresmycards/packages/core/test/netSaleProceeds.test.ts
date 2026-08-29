import { describe, it, expect } from "vitest";
import { computeNetSaleProceeds } from "../src/calc/netSaleProceeds.js";
import { DEFAULT_FEE_SCHEDULE } from "../src/calc/types.js";

describe("computeNetSaleProceeds", () => {
  it("deducts marketplace fee, fixed fee, postage, insurance and packaging from sale price", () => {
    const result = computeNetSaleProceeds({
      salePrice: 100,
      outboundPostage: 5,
      insurance: 1,
      packaging: 1,
    });

    const expectedFvf = 100 * DEFAULT_FEE_SCHEDULE.ebayFinalValueFeePct;
    const expectedDeductions = expectedFvf + DEFAULT_FEE_SCHEDULE.ebayFixedFeePerOrder + 5 + 1 + 1;

    expect(result.marketplaceFee).toBeCloseTo(expectedFvf, 2);
    expect(result.totalDeductions).toBeCloseTo(expectedDeductions, 2);
    expect(result.netProceeds).toBeCloseTo(100 - expectedDeductions, 2);
  });

  it("uses default postage/packaging from the fee schedule when not provided", () => {
    const result = computeNetSaleProceeds({ salePrice: 50 });
    expect(result.outboundPostage).toBe(DEFAULT_FEE_SCHEDULE.outboundPostageDefault);
    expect(result.packaging).toBe(DEFAULT_FEE_SCHEDULE.packagingDefault);
    expect(result.insurance).toBe(0);
  });

  it("applies per-call fee overrides without mutating the default schedule", () => {
    const result = computeNetSaleProceeds({
      salePrice: 100,
      fees: { ebayFinalValueFeePct: 0.10, ebayFixedFeePerOrder: 0, paymentProcessingPct: 0.02 },
    });
    expect(result.marketplaceFee).toBeCloseTo(10, 2);
    expect(result.fixedFee).toBe(0);
    expect(result.paymentProcessingFee).toBeCloseTo(2, 2);
    expect(DEFAULT_FEE_SCHEDULE.ebayFinalValueFeePct).toBe(0.1325); // untouched
  });

  it("can produce a negative netProceeds when fees exceed sale price (tiny/low-value listing)", () => {
    const result = computeNetSaleProceeds({ salePrice: 1, outboundPostage: 4.5, packaging: 1.5 });
    expect(result.netProceeds).toBeLessThan(0);
  });

  it("throws on negative sale price", () => {
    expect(() => computeNetSaleProceeds({ salePrice: -10 })).toThrow();
  });
});
