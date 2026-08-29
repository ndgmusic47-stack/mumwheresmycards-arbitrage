import { describe, it, expect } from "vitest";
import { computeAcquisitionCost } from "../src/calc/acquisitionCost.js";

describe("computeAcquisitionCost", () => {
  it("sums purchase price, seller postage, import tax and acquisition fees", () => {
    const result = computeAcquisitionCost({
      purchasePrice: 100,
      sellerPostage: 5.5,
      importTax: 12.3,
      acquisitionFees: 2,
    });

    expect(result.total).toBe(119.8);
    expect(result.purchasePrice).toBe(100);
    expect(result.sellerPostage).toBe(5.5);
    expect(result.importTax).toBe(12.3);
    expect(result.acquisitionFees).toBe(2);
  });

  it("defaults optional import tax and acquisition fees to 0", () => {
    const result = computeAcquisitionCost({ purchasePrice: 50, sellerPostage: 3 });
    expect(result.total).toBe(53);
    expect(result.importTax).toBe(0);
    expect(result.acquisitionFees).toBe(0);
  });

  it("rounds to 2 decimal places to avoid floating point drift", () => {
    const result = computeAcquisitionCost({ purchasePrice: 19.99, sellerPostage: 3.33, acquisitionFees: 0.01 });
    expect(result.total).toBe(23.33);
  });

  it("handles zero-cost postage (local pickup / free postage listings)", () => {
    const result = computeAcquisitionCost({ purchasePrice: 40, sellerPostage: 0 });
    expect(result.total).toBe(40);
  });

  it("throws on negative purchase price", () => {
    expect(() => computeAcquisitionCost({ purchasePrice: -1, sellerPostage: 0 })).toThrow();
  });

  it("throws on negative seller postage", () => {
    expect(() => computeAcquisitionCost({ purchasePrice: 10, sellerPostage: -5 })).toThrow();
  });

  it("throws on negative import tax", () => {
    expect(() => computeAcquisitionCost({ purchasePrice: 10, sellerPostage: 0, importTax: -1 })).toThrow();
  });
});
