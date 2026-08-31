import { describe, it, expect } from "vitest";
import {
  classifyGradeEconomics,
  computeGradeLadder,
  computeRequiredPsa10HitRate,
  DEFAULT_CLASSIFICATION_SETTINGS,
} from "../src/index.js";

describe("economic classification", () => {
  it("classifies a card that already breaks even at PSA 7 as DOWNSIDE PROTECTED", () => {
    // Cheap basis, healthy slab values all the way down the ladder.
    const ladder = computeGradeLadder({
      totalGradedBasis: 100,
      slabValues: { 7: 200, 8: 300, 9: 600, 10: 2000 },
    });
    const result = classifyGradeEconomics(ladder);

    expect(result.economicClass).toBe("DOWNSIDE_PROTECTED");
    expect(result.rationale).toMatch(/PSA 7/);
  });

  it("classifies a bounded PSA8 loss with strong PSA9 economics as BALANCED", () => {
    // PSA8 slightly negative (within -10% of basis), PSA9 well clear of the bar.
    const ladder = computeGradeLadder({
      totalGradedBasis: 200,
      slabValues: { 7: 80, 8: 235, 9: 400, 10: 900 },
    });
    const result = classifyGradeEconomics(ladder);

    const psa8 = ladder.rungs.find((r) => r.grade === 8)!.profit!;
    const psa9 = ladder.rungs.find((r) => r.grade === 9)!.profit!;

    expect(psa8).toBeLessThan(0);
    expect(psa8).toBeGreaterThanOrEqual(result.balancedPsa8LossFloor);
    expect(psa9).toBeGreaterThanOrEqual(result.balancedPsa9ProfitThreshold);
    expect(result.economicClass).toBe("BALANCED");
  });

  it("surfaces a big PSA10 spread as ASYMMETRIC even though PSA8 loses money", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 300,
      slabValues: { 7: 50, 8: 100, 9: 250, 10: 4000 },
    });
    const result = classifyGradeEconomics(ladder);

    expect(ladder.rungs.find((r) => r.grade === 8)!.profit).toBeLessThan(0);
    expect(ladder.rungs.find((r) => r.grade === 9)!.profit).toBeLessThan(0);
    // Not thrown away despite losing at 8 AND 9 — this is the structure the
    // business most wants to discover.
    expect(result.economicClass).toBe("ASYMMETRIC");
    expect(result.rationale).toMatch(/Lower grades lose money/);
  });

  it("does NOT require PSA8 or PSA9 profitability for the asymmetric class", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 400,
      slabValues: { 8: 50, 9: 120, 10: 6000 },
    });
    expect(classifyGradeEconomics(ladder).satisfiedClasses).toContain("ASYMMETRIC");
  });

  it("prefers the strongest structure when several apply", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 100,
      slabValues: { 7: 250, 8: 400, 9: 900, 10: 5000 },
    });
    const result = classifyGradeEconomics(ladder);

    expect(result.satisfiedClasses.length).toBeGreaterThan(1);
    expect(result.economicClass).toBe("DOWNSIDE_PROTECTED");
  });

  it("leaves a genuinely bad card UNCLASSIFIED, with reasons", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 500,
      slabValues: { 7: 50, 8: 80, 9: 150, 10: 300 },
    });
    const result = classifyGradeEconomics(ladder);

    expect(result.economicClass).toBe("UNCLASSIFIED");
    expect(result.unclassifiedReasons.length).toBeGreaterThan(0);
  });

  it("honours edited thresholds without a code change", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 300,
      slabValues: { 8: 100, 9: 250, 10: 2200 },
    });

    // Default asymmetric bar is £500 profit AND 5x gross — this card clears it.
    expect(classifyGradeEconomics(ladder).economicClass).toBe("ASYMMETRIC");

    // Raise the bar and the same card no longer qualifies.
    const stricter = classifyGradeEconomics(ladder, {
      ...DEFAULT_CLASSIFICATION_SETTINGS,
      asymmetricMinPsa10Profit: 5000,
    });
    expect(stricter.economicClass).toBe("UNCLASSIFIED");
  });

  it("scales the PSA9 balanced bar with basis size (max of £ and %)", () => {
    const smallBasis = computeGradeLadder({ totalGradedBasis: 100, slabValues: { 8: 100, 9: 200 } });
    const bigBasis = computeGradeLadder({ totalGradedBasis: 1000, slabValues: { 8: 1000, 9: 2000 } });

    // £40 floor dominates on a small basis; 25% dominates on a large one.
    expect(classifyGradeEconomics(smallBasis).balancedPsa9ProfitThreshold).toBe(40);
    expect(classifyGradeEconomics(bigBasis).balancedPsa9ProfitThreshold).toBe(250);
  });
});

describe("required PSA10 hit rate — honest metric, not fake EV", () => {
  it("matches the worked example: -£50 at PSA9, +£950 at PSA10 => ~5%", () => {
    const result = computeRequiredPsa10HitRate({
      fallbackProfit: -50,
      psa10Profit: 950,
      fallbackLabel: "PSA 9",
    });

    expect(result.requiredRate).toBeCloseTo(0.05, 4);
    expect(result.explanation).toMatch(/REQUIRED rate, not a predicted one/);
  });

  it("labels the metric REQUIRED, never EXPECTED", () => {
    const result = computeRequiredPsa10HitRate({
      fallbackProfit: -100,
      psa10Profit: 400,
      fallbackLabel: "PSA 8",
    });
    expect(result.explanation).toContain("REQUIRED");
    expect(result.explanation).not.toMatch(/\bexpected\b/i);
  });

  it("requires zero PSA10s when the fallback grade is already profitable", () => {
    const result = computeRequiredPsa10HitRate({
      fallbackProfit: 120,
      psa10Profit: 900,
      fallbackLabel: "PSA 9",
    });

    expect(result.requiredRate).toBe(0);
    expect(result.alreadyProfitableAtFallback).toBe(true);
  });

  it("reports impossibility when even a PSA10 loses money", () => {
    const result = computeRequiredPsa10HitRate({
      fallbackProfit: -50,
      psa10Profit: -10,
      fallbackLabel: "PSA 9",
    });

    expect(result.requiredRate).toBeNull();
    expect(result.impossible).toBe(true);
  });

  it("is not computable without the underlying grade data", () => {
    const result = computeRequiredPsa10HitRate({
      fallbackProfit: null,
      psa10Profit: 900,
      fallbackLabel: "PSA 9",
    });
    expect(result.requiredRate).toBeNull();
  });

  it("needs a higher hit rate as the fallback loss deepens", () => {
    const shallow = computeRequiredPsa10HitRate({ fallbackProfit: -20, psa10Profit: 500, fallbackLabel: "PSA 9" });
    const deep = computeRequiredPsa10HitRate({ fallbackProfit: -200, psa10Profit: 500, fallbackLabel: "PSA 9" });
    expect(deep.requiredRate!).toBeGreaterThan(shallow.requiredRate!);
  });

  it("computes the PSA8 fallback independently of the PSA9 one", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 300,
      slabValues: { 8: 100, 9: 250, 10: 3000 },
    });
    const psa8Profit = ladder.rungs.find((r) => r.grade === 8)!.profit;
    const psa9Profit = ladder.rungs.find((r) => r.grade === 9)!.profit;
    const psa10Profit = ladder.rungs.find((r) => r.grade === 10)!.profit;

    const vsPsa9 = computeRequiredPsa10HitRate({ fallbackProfit: psa9Profit, psa10Profit, fallbackLabel: "PSA 9" });
    const vsPsa8 = computeRequiredPsa10HitRate({ fallbackProfit: psa8Profit, psa10Profit, fallbackLabel: "PSA 8" });

    // A worse fallback grade needs more 10s to break even.
    expect(vsPsa8.requiredRate!).toBeGreaterThan(vsPsa9.requiredRate!);
  });
});
