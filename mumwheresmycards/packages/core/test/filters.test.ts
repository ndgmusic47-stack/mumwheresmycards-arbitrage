import { describe, it, expect } from "vitest";
import { evaluateFilters, isSafeZone } from "../src/filters/predicates.js";
import type { FilterSet, FilterableOpportunity } from "../src/filters/types.js";

const filters: FilterSet = {
  global: {
    strategy: "BOTH",
    minNetProfit: 50,
    minReturnOnCapital: 0.35,
    minProfitMargin: 0.15,
    maxAcquisitionPrice: 100,
    minLiquidity: "HIGH",
    minConfidence: 0.8,
  },
  flip: { minQsv: 20, maxDaysToSale: 30 },
  grade: {
    minPsa10Value: 80,
    minPsa10UpsideMultiple: 2.0,
    minAcceptableBreakEvenGrade: 8,
    safeZoneOnly: false,
    maxGradedBasis: 300,
  },
};

function baseFlip(overrides: Partial<FilterableOpportunity> = {}): FilterableOpportunity {
  return {
    strategy: "FLIP",
    netProfit: 60,
    returnOnCapital: 0.4,
    profitMargin: 0.2,
    acquisitionPrice: 80,
    liquidity: "HIGH",
    confidence: 0.85,
    qsv: 150,
    daysToSaleEstimate: 10,
    ...overrides,
  };
}

function baseGrade(overrides: Partial<FilterableOpportunity> = {}): FilterableOpportunity {
  return {
    strategy: "GRADE",
    netProfit: 60,
    returnOnCapital: 0.4,
    profitMargin: 0.2,
    acquisitionPrice: 80,
    liquidity: "HIGH",
    confidence: 0.85,
    psa10Value: 500,
    psa10UpsideMultiple: 3,
    breakEvenGrade: 7,
    gradedBasis: 150,
    ...overrides,
  };
}

describe("evaluateFilters — example from spec", () => {
  it("passes an opportunity matching: Net profit >= £50, ROC >= 35%, Liquidity >= HIGH, Confidence >= 80%, Acquisition <= £100", () => {
    const result = evaluateFilters(baseFlip(), filters);
    expect(result.passes).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe("evaluateFilters — global filters", () => {
  it("fails on strategy mismatch when strategy filter is not BOTH", () => {
    const flipOnly: FilterSet = { ...filters, global: { ...filters.global, strategy: "GRADE" } };
    const result = evaluateFilters(baseFlip(), flipOnly);
    expect(result.passes).toBe(false);
    expect(result.failures.map((f) => f.filter)).toContain("strategy");
  });

  it("fails when net profit is below minimum", () => {
    const result = evaluateFilters(baseFlip({ netProfit: 10 }), filters);
    expect(result.passes).toBe(false);
    expect(result.failures.map((f) => f.filter)).toContain("minNetProfit");
  });

  it("fails when ROC is below minimum", () => {
    const result = evaluateFilters(baseFlip({ returnOnCapital: 0.1 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("minReturnOnCapital");
  });

  it("fails when profit margin is below minimum", () => {
    const result = evaluateFilters(baseFlip({ profitMargin: 0.05 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("minProfitMargin");
  });

  it("fails when acquisition price exceeds the maximum", () => {
    const result = evaluateFilters(baseFlip({ acquisitionPrice: 500 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("maxAcquisitionPrice");
  });

  it("fails when liquidity is below the minimum ordinal level", () => {
    const result = evaluateFilters(baseFlip({ liquidity: "MEDIUM" }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("minLiquidity");
  });

  it("fails when confidence is below the minimum", () => {
    const result = evaluateFilters(baseFlip({ confidence: 0.5 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("minConfidence");
  });

  it("collects multiple simultaneous failures", () => {
    const result = evaluateFilters(baseFlip({ netProfit: 1, returnOnCapital: 0, confidence: 0 }), filters);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });
});

describe("evaluateFilters — FLIP-specific filters", () => {
  it("fails when QSV is below minimum", () => {
    const result = evaluateFilters(baseFlip({ qsv: 5 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("minQsv");
  });

  it("fails when expected days-to-sale exceeds the maximum", () => {
    const result = evaluateFilters(baseFlip({ daysToSaleEstimate: 90 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("maxDaysToSale");
  });

  it("does not apply GRADE-only filters to a FLIP opportunity", () => {
    const result = evaluateFilters(baseFlip(), filters);
    expect(result.failures.map((f) => f.filter)).not.toContain("minPsa10Value");
  });
});

describe("evaluateFilters — GRADE-specific filters", () => {
  it("fails when PSA10 value is below minimum", () => {
    const result = evaluateFilters(baseGrade({ psa10Value: 10 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("minPsa10Value");
  });

  it("fails when PSA10 upside multiple is below minimum", () => {
    const result = evaluateFilters(baseGrade({ psa10UpsideMultiple: 1 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("minPsa10UpsideMultiple");
  });

  it("fails when break-even grade is worse (higher) than acceptable, or missing", () => {
    const worse = evaluateFilters(baseGrade({ breakEvenGrade: 9 }), filters);
    expect(worse.failures.map((f) => f.filter)).toContain("minAcceptableBreakEvenGrade");

    const none = evaluateFilters(baseGrade({ breakEvenGrade: null }), filters);
    expect(none.failures.map((f) => f.filter)).toContain("minAcceptableBreakEvenGrade");
  });

  it("passes when break-even grade is at or better than acceptable", () => {
    const result = evaluateFilters(baseGrade({ breakEvenGrade: 8 }), filters);
    expect(result.failures.map((f) => f.filter)).not.toContain("minAcceptableBreakEvenGrade");
  });

  it("applies safe-zone filter only when enabled", () => {
    const safeZoneFilters: FilterSet = { ...filters, grade: { ...filters.grade, safeZoneOnly: true } };
    const outsideSafeZone = evaluateFilters(baseGrade({ breakEvenGrade: 9 }), safeZoneFilters);
    expect(outsideSafeZone.failures.map((f) => f.filter)).toContain("safeZoneOnly");

    const insideSafeZone = evaluateFilters(baseGrade({ breakEvenGrade: 7 }), safeZoneFilters);
    expect(insideSafeZone.failures.map((f) => f.filter)).not.toContain("safeZoneOnly");
  });

  it("fails when graded basis exceeds the maximum", () => {
    const result = evaluateFilters(baseGrade({ gradedBasis: 1000 }), filters);
    expect(result.failures.map((f) => f.filter)).toContain("maxGradedBasis");
  });
});

describe("isSafeZone", () => {
  it("is true only when break-even grade is at or below the safe-zone cutoff", () => {
    expect(isSafeZone(6)).toBe(true);
    expect(isSafeZone(7)).toBe(true);
    expect(isSafeZone(8)).toBe(false);
    expect(isSafeZone(null)).toBe(false);
  });

  it("respects a custom cutoff", () => {
    expect(isSafeZone(8, 8)).toBe(true);
    expect(isSafeZone(9, 8)).toBe(false);
  });
});
