import { describe, it, expect } from "vitest";
import { computeGradingBasis } from "../src/calc/gradingBasis.js";
import { DEFAULT_FEE_SCHEDULE } from "../src/calc/types.js";

describe("computeGradingBasis", () => {
  it("sums raw purchase, postage, packaging, sleeve, card saver, insured postage, grading fee, return shipping and insurance", () => {
    const result = computeGradingBasis({
      rawPurchasePrice: 50,
      sellerPostage: 3,
      returnShipping: 6,
      insurance: 2,
    });

    const expectedTotal =
      50 +
      3 +
      DEFAULT_FEE_SCHEDULE.packagingDefault +
      DEFAULT_FEE_SCHEDULE.sleeveCost +
      DEFAULT_FEE_SCHEDULE.cardSaverCost +
      DEFAULT_FEE_SCHEDULE.insuredPostageAllocation +
      DEFAULT_FEE_SCHEDULE.gradingFeePsaRegular +
      6 +
      2;

    expect(result.total).toBeCloseTo(expectedTotal, 2);
    expect(result.upchargeReserve).toBe(0);
  });

  it("adds the PSA upcharge reserve only when upchargeReserveApplies is true", () => {
    const withoutReserve = computeGradingBasis({
      rawPurchasePrice: 500,
      sellerPostage: 5,
      returnShipping: 8,
      insurance: 5,
    });
    const withReserve = computeGradingBasis({
      rawPurchasePrice: 500,
      sellerPostage: 5,
      returnShipping: 8,
      insurance: 5,
      upchargeReserveApplies: true,
    });

    expect(withReserve.upchargeReserve).toBe(DEFAULT_FEE_SCHEDULE.gradingUpchargeReserve);
    expect(withReserve.total - withoutReserve.total).toBeCloseTo(DEFAULT_FEE_SCHEDULE.gradingUpchargeReserve, 2);
  });

  it("allows overriding individual cost components", () => {
    const result = computeGradingBasis({
      rawPurchasePrice: 20,
      sellerPostage: 2,
      packaging: 0,
      sleeve: 0,
      cardSaver: 0,
      insuredGradingPostageAllocation: 10,
      gradingFee: 30,
      returnShipping: 5,
      insurance: 0,
    });

    expect(result.total).toBeCloseTo(20 + 2 + 0 + 0 + 0 + 10 + 30 + 5 + 0, 2);
  });

  it("throws on negative raw purchase price", () => {
    expect(() => computeGradingBasis({ rawPurchasePrice: -1, sellerPostage: 0, returnShipping: 0, insurance: 0 })).toThrow();
  });
});
