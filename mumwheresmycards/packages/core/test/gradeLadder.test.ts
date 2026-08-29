import { describe, it, expect } from "vitest";
import { computeGradeLadder, findBreakEvenGrade } from "../src/calc/gradeLadder.js";

describe("computeGradeLadder", () => {
  it("computes net proceeds and profit at every populated PSA grade", () => {
    const result = computeGradeLadder({
      totalGradedBasis: 100,
      psaPrices: { 6: 80, 7: 100, 8: 150, 9: 250, 10: 600 },
    });

    expect(result.rungs).toHaveLength(5);
    const psa10 = result.rungs.find((r) => r.grade === 10)!;
    expect(psa10.marketPrice).toBe(600);
    expect(psa10.netProceeds).toBeLessThan(600); // fees deducted
    expect(psa10.profit).toBeCloseTo(psa10.netProceeds! - 100, 2);
  });

  it("leaves rungs null when market data is missing for a grade", () => {
    const result = computeGradeLadder({
      totalGradedBasis: 50,
      psaPrices: { 9: 200, 10: 500 },
    });

    const psa6 = result.rungs.find((r) => r.grade === 6)!;
    expect(psa6.marketPrice).toBeNull();
    expect(psa6.netProceeds).toBeNull();
    expect(psa6.profit).toBeNull();
  });

  it("finds the lowest break-even grade (ascending)", () => {
    // PSA6/7 lose money, PSA8+ profit
    const result = computeGradeLadder({
      totalGradedBasis: 120,
      psaPrices: { 6: 50, 7: 90, 8: 160, 9: 220, 10: 500 },
    });

    expect(result.breakEvenGrade).toBe(8);
  });

  it("returns null break-even grade when no grade ever profits", () => {
    const result = computeGradeLadder({
      totalGradedBasis: 1000,
      psaPrices: { 6: 10, 7: 15, 8: 20, 9: 30, 10: 50 },
    });

    expect(result.breakEvenGrade).toBeNull();
  });

  it("computes psa10UpsideMultiple as PSA10 net proceeds / total graded basis", () => {
    const result = computeGradeLadder({
      totalGradedBasis: 100,
      psaPrices: { 10: 400 },
    });
    const psa10 = result.rungs.find((r) => r.grade === 10)!;
    expect(result.psa10UpsideMultiple).toBeCloseTo(psa10.netProceeds! / 100, 4);
  });

  it("returns null psa10UpsideMultiple when PSA10 price is unavailable", () => {
    const result = computeGradeLadder({ totalGradedBasis: 100, psaPrices: { 9: 200 } });
    expect(result.psa10UpsideMultiple).toBeNull();
  });

  it("throws when totalGradedBasis is zero or negative", () => {
    expect(() => computeGradeLadder({ totalGradedBasis: 0, psaPrices: { 10: 100 } })).toThrow();
  });
});

describe("findBreakEvenGrade", () => {
  it("returns null for an empty rung list", () => {
    expect(findBreakEvenGrade([])).toBeNull();
  });

  it("ignores rungs without profit data", () => {
    expect(
      findBreakEvenGrade([
        { grade: 6, marketPrice: null, netProceeds: null, profit: null },
        { grade: 7, marketPrice: 50, netProceeds: 40, profit: -5 },
        { grade: 8, marketPrice: 100, netProceeds: 85, profit: 10 },
      ]),
    ).toBe(8);
  });
});
