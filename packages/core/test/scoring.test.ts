import { describe, it, expect } from "vitest";
import {
  computeFlipScore,
  computeGradeScore,
  DEFAULT_FLIP_SCORE_WEIGHTS,
  DEFAULT_GRADE_SCORE_WEIGHTS,
  ECONOMIC_CLASS_SCORE,
} from "../src/index.js";

describe("computeFlipScore", () => {
  it("returns 0-100 and rewards better economics", () => {
    const strong = computeFlipScore({
      returnOnCapital: 1.2,
      netProfit: 400,
      liquidity: "VERY_HIGH",
      confidence: 1,
      listingQuality: 1,
    });
    const weak = computeFlipScore({
      returnOnCapital: 0.05,
      netProfit: 5,
      liquidity: "LOW",
      confidence: 0.1,
      listingQuality: 0.1,
    });

    expect(strong.score).toBe(100);
    expect(weak.score).toBeLessThan(20);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("weights sum to one", () => {
    const sum = Object.values(DEFAULT_FLIP_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("rejects weights that do not sum to one", () => {
    expect(() =>
      computeFlipScore({
        returnOnCapital: 0.5,
        netProfit: 100,
        liquidity: "HIGH",
        confidence: 0.8,
        listingQuality: 0.5,
        weights: { returnOnCapital: 0.9, netProfit: 0.9 },
      }),
    ).toThrow(/sum to 1/);
  });

  it("exposes a per-component breakdown so a score is explainable", () => {
    const result = computeFlipScore({
      returnOnCapital: 0.5,
      netProfit: 100,
      liquidity: "HIGH",
      confidence: 0.8,
      listingQuality: 0.6,
    });
    expect(Object.keys(result.components)).toContain("returnOnCapital");
    expect(result.components.netProfit!.contribution).toBeGreaterThan(0);
  });
});

describe("computeGradeScore — ranking only", () => {
  const baseline = {
    psa7Profit: 0,
    psa9Profit: 100,
    psa9ReturnOnCapital: 0.5,
    psa10GrossMultiple: 3,
    requiredPsa10Rate: 0.1,
    gradedBasis: 200,
    slabLiquidity: "MEDIUM" as const,
    dataConfidence: 0.7,
    estimatedCapitalLockDays: 135,
  };

  it("gives DOWNSIDE PROTECTED a major scoring advantage", () => {
    const protectedCard = computeGradeScore({ ...baseline, economicClass: "DOWNSIDE_PROTECTED" });
    const balanced = computeGradeScore({ ...baseline, economicClass: "BALANCED" });
    const asymmetric = computeGradeScore({ ...baseline, economicClass: "ASYMMETRIC" });

    expect(protectedCard.score).toBeGreaterThan(balanced.score);
    expect(balanced.score).toBeGreaterThan(asymmetric.score);
    expect(ECONOMIC_CLASS_SCORE.DOWNSIDE_PROTECTED).toBe(1);
  });

  it("rewards a LOWER required PSA10 hit rate", () => {
    const easy = computeGradeScore({ ...baseline, economicClass: "ASYMMETRIC", requiredPsa10Rate: 0.03 });
    const hard = computeGradeScore({ ...baseline, economicClass: "ASYMMETRIC", requiredPsa10Rate: 0.6 });
    expect(easy.score).toBeGreaterThan(hard.score);
  });

  it("rewards faster capital return", () => {
    const fast = computeGradeScore({ ...baseline, economicClass: "BALANCED", estimatedCapitalLockDays: 40 });
    const slow = computeGradeScore({ ...baseline, economicClass: "BALANCED", estimatedCapitalLockDays: 320 });
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it("rewards bigger PSA10 upside", () => {
    const big = computeGradeScore({ ...baseline, economicClass: "BALANCED", psa10GrossMultiple: 9 });
    const small = computeGradeScore({ ...baseline, economicClass: "BALANCED", psa10GrossMultiple: 1.2 });
    expect(big.score).toBeGreaterThan(small.score);
  });

  it("weights sum to one", () => {
    const sum = Object.values(DEFAULT_GRADE_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("never uses a fabricated grade probability as a weight", () => {
    // There is no gem-rate / probability input on the score at all.
    expect(Object.keys(DEFAULT_GRADE_SCORE_WEIGHTS)).not.toContain("gemRate");
    expect(Object.keys(DEFAULT_GRADE_SCORE_WEIGHTS)).not.toContain("expectedValue");
  });

  it("scores an unclassified card at the bottom without excluding it from the range", () => {
    const unclassified = computeGradeScore({ ...baseline, economicClass: "UNCLASSIFIED" });
    expect(unclassified.score).toBeGreaterThanOrEqual(0);
    expect(unclassified.score).toBeLessThan(
      computeGradeScore({ ...baseline, economicClass: "ASYMMETRIC" }).score,
    );
  });
});
