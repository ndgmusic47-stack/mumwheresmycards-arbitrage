import { describe, expect, it } from "vitest";
import { computePriceContext } from "../src/opportunity/priceContext.js";

describe("computePriceContext (SOURCING WORKFLOW item 10)", () => {
  it("uses QSV as the reference for FLIP, computing a positive discount when delivered cost is below it", () => {
    const result = computePriceContext({
      strategy: "FLIP",
      totalAcquisitionCost: 80,
      qsv: 100,
      rawMarketPrice: 120, // deliberately different — must be ignored for FLIP
    });
    expect(result.referenceLabel).toBe("QSV");
    expect(result.referenceValue).toBe(100);
    expect(result.discountFraction).toBe(0.2); // 20% below QSV
  });

  it("reports a negative discount fraction when delivered cost is ABOVE the reference, never clamping to zero", () => {
    const result = computePriceContext({
      strategy: "FLIP",
      totalAcquisitionCost: 130,
      qsv: 100,
      rawMarketPrice: null,
    });
    expect(result.discountFraction).toBe(-0.3);
  });

  it("returns a null reference/discount for FLIP when qsv is null, never falling back to raw market price", () => {
    const result = computePriceContext({
      strategy: "FLIP",
      totalAcquisitionCost: 80,
      qsv: null,
      rawMarketPrice: 120,
    });
    expect(result.referenceLabel).toBe("QSV");
    expect(result.referenceValue).toBeNull();
    expect(result.discountFraction).toBeNull();
  });

  it("uses raw market value as the reference for GRADE, never QSV even when one happens to be present", () => {
    const result = computePriceContext({
      strategy: "GRADE",
      totalAcquisitionCost: 50,
      qsv: 999, // must be ignored for GRADE
      rawMarketPrice: 60,
    });
    expect(result.referenceLabel).toBe("raw market value");
    expect(result.referenceValue).toBe(60);
    expect(result.discountFraction).toBeCloseTo(0.1667, 4);
  });

  it("returns a null reference/discount for GRADE when rawMarketPrice is null", () => {
    const result = computePriceContext({
      strategy: "GRADE",
      totalAcquisitionCost: 50,
      qsv: null,
      rawMarketPrice: null,
    });
    expect(result.referenceValue).toBeNull();
    expect(result.discountFraction).toBeNull();
  });

  it("treats a zero or negative reference as unusable rather than producing a meaningless/huge fraction", () => {
    const result = computePriceContext({
      strategy: "FLIP",
      totalAcquisitionCost: 80,
      qsv: 0,
      rawMarketPrice: null,
    });
    expect(result.referenceValue).toBeNull();
    expect(result.discountFraction).toBeNull();
  });
});
