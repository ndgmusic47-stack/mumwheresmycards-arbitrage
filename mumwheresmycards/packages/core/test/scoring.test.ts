import { describe, it, expect } from "vitest";
import { computeFlipScore, DEFAULT_FLIP_SCORE_WEIGHTS } from "../src/scoring/flipScore.js";
import { computeGradeScore, DEFAULT_GRADE_SCORE_WEIGHTS } from "../src/scoring/gradeScore.js";
import { clamp01, normalizeCapped, normalizeRange } from "../src/scoring/normalize.js";

describe("normalize helpers", () => {
  it("clamp01 clamps to [0,1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
  });

  it("normalizeCapped maps [0, cap] to [0, 1]", () => {
    expect(normalizeCapped(0, 100)).toBe(0);
    expect(normalizeCapped(50, 100)).toBe(0.5);
    expect(normalizeCapped(150, 100)).toBe(1);
    expect(normalizeCapped(50, 0)).toBe(0);
  });

  it("normalizeRange maps [min,max] to [0,1] and clamps outside", () => {
    expect(normalizeRange(-1, -1, 0.5)).toBe(0);
    expect(normalizeRange(0.5, -1, 0.5)).toBe(1);
    expect(normalizeRange(-2, -1, 0.5)).toBe(0);
    expect(normalizeRange(1, -1, 0.5)).toBe(1);
  });
});

describe("computeFlipScore", () => {
  it("produces a score of 100 when every component is maxed", () => {
    const result = computeFlipScore({
      returnOnCapital: 2.0, // above cap
      netProfit: 1000, // above cap
      liquidity: "VERY_HIGH",
      confidence: 1,
      listingQuality: 1,
    });
    expect(result.score).toBe(100);
  });

  it("produces a score of 0 when every component is at its floor", () => {
    const result = computeFlipScore({
      returnOnCapital: 0,
      netProfit: 0,
      liquidity: "LOW",
      confidence: 0,
      listingQuality: 0,
    });
    expect(result.score).toBe(0);
  });

  it("weights return on capital most heavily by default", () => {
    const base = { netProfit: 0, liquidity: "LOW" as const, confidence: 0, listingQuality: 0 };
    const highRoc = computeFlipScore({ ...base, returnOnCapital: 1 });
    const highProfit = computeFlipScore({ ...base, returnOnCapital: 0, netProfit: 200 });
    expect(highRoc.score).toBeGreaterThan(highProfit.score);
  });

  it("respects custom weight overrides", () => {
    const result = computeFlipScore({
      returnOnCapital: 1,
      netProfit: 0,
      liquidity: "LOW",
      confidence: 0,
      listingQuality: 0,
      weights: { returnOnCapital: 1, netProfit: 0, liquidity: 0, confidence: 0, listingQuality: 0 },
    });
    expect(result.score).toBe(100);
  });

  it("throws if custom weights don't sum to 1", () => {
    expect(() =>
      computeFlipScore({
        returnOnCapital: 1,
        netProfit: 0,
        liquidity: "LOW",
        confidence: 0,
        listingQuality: 0,
        weights: { returnOnCapital: 0.5 },
      }),
    ).toThrow();
  });

  it("default weights sum to 1", () => {
    const sum = Object.values(DEFAULT_FLIP_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe("computeGradeScore", () => {
  it("default weights sum to 1", () => {
    const sum = Object.values(DEFAULT_GRADE_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("rewards strong downside protection, PSA9 economics and PSA10 upside", () => {
    const strong = computeGradeScore({
      worstCaseReturnOnCapital: 0.5,
      psa9ReturnOnCapital: 1.5,
      psa10UpsideMultiple: 4,
      bargainRatio: 2,
      slabLiquidity: "VERY_HIGH",
      dataConfidence: 1,
    });
    const weak = computeGradeScore({
      worstCaseReturnOnCapital: -1,
      psa9ReturnOnCapital: 0,
      psa10UpsideMultiple: 0,
      bargainRatio: 0,
      slabLiquidity: "LOW",
      dataConfidence: 0,
    });
    expect(strong.score).toBe(100);
    expect(weak.score).toBe(0);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("penalizes negative worst-case ROC (downside risk) more than break-even", () => {
    const breakEven = computeGradeScore({
      worstCaseReturnOnCapital: 0,
      psa9ReturnOnCapital: 0.5,
      psa10UpsideMultiple: 2,
      bargainRatio: 1,
      slabLiquidity: "MEDIUM",
      dataConfidence: 0.5,
    });
    const negative = computeGradeScore({
      worstCaseReturnOnCapital: -0.5,
      psa9ReturnOnCapital: 0.5,
      psa10UpsideMultiple: 2,
      bargainRatio: 1,
      slabLiquidity: "MEDIUM",
      dataConfidence: 0.5,
    });
    expect(negative.score).toBeLessThan(breakEven.score);
  });
});
