import { describe, it, expect } from "vitest";
import { computeGradeLadder, findBreakEven } from "../src/calc/gradeLadder.js";
import { classifyGradeEconomics, DEFAULT_CLASSIFICATION_SETTINGS } from "../src/grading/classification.js";
import { qualifyGrade } from "../src/filters/predicates.js";
import { DEFAULT_GRADE_QUALIFICATION } from "../src/filters/types.js";

/**
 * THE LOW-GRADE STRATEGY: "buy at £50, make £300 at a PSA 6."
 *
 * Every test here exists because the tool could not previously express that
 * sentence. PSA 6 was read from the provider and then ignored by the no-data
 * guard, the classifier and every filter; break-even silently skipped grades
 * it had no price for; and there was no way to say "this grade's price has
 * no sales behind it".
 */

const BASIS = 90;

function ladder(slabValues: Record<number, number | null>, extra: Parameters<typeof computeGradeLadder>[0] extends infer _ ? Record<string, unknown> : never = {}) {
  return computeGradeLadder({ totalGradedBasis: BASIS, slabValues, ...extra } as never);
}

describe("break-even no longer hides what it could not test", () => {
  it("reports the grades below the break-even that had no price", () => {
    // No PSA 6 or 7 data at all; 8 is the first priced rung and it pays.
    const result = ladder({ 6: null, 7: null, 8: 400, 9: 600, 10: 900 });

    expect(result.breakEvenGrade).toBe(8);
    // The old behaviour stopped here, and "breaks even at 8" was
    // indistinguishable from "6 and 7 were checked and lose money".
    expect(result.breakEvenUntestedBelow).toEqual([6, 7]);
  });

  it("reports nothing untested when every lower grade really was checked", () => {
    const result = ladder({ 6: 20, 7: 40, 8: 400, 9: 600, 10: 900 });

    expect(result.breakEvenGrade).toBe(8);
    // 6 and 7 are priced and genuinely lose against a £90 basis.
    expect(result.breakEvenUntestedBelow).toEqual([]);
  });

  it("a card that pays at PSA 6 breaks even at PSA 6, with nothing untested", () => {
    const result = ladder({ 6: 400, 7: 450, 8: 500, 9: 700, 10: 1200 });
    expect(result.breakEvenGrade).toBe(6);
    expect(result.breakEvenUntestedBelow).toEqual([]);
  });

  it("findBreakEven reports no untested grades when nothing breaks even at all", () => {
    // Untested rungs are not "below" a break-even that does not exist, and
    // claiming otherwise would be its own false precision.
    const rungs = ladder({ 6: null, 7: 10, 8: 20, 9: 30, 10: 40 }).rungs;
    expect(findBreakEven(rungs)).toEqual({ grade: null, untestedBelow: [] });
  });
});

describe("the evidence behind each grade travels with its price", () => {
  it("carries the sale count and the estimated flag onto each rung", () => {
    const result = computeGradeLadder({
      totalGradedBasis: BASIS,
      slabValues: { 6: 400, 9: 600 },
      saleCounts: { 6: 12, 9: 1 },
      estimatedGrades: [9],
    });

    const six = result.rungs.find((r) => r.grade === 6)!;
    const nine = result.rungs.find((r) => r.grade === 9)!;

    expect(six.saleCount).toBe(12);
    expect(six.valueIsEstimated).toBe(false);
    expect(nine.saleCount).toBe(1);
    expect(nine.valueIsEstimated).toBe(true);
  });

  it("an unknown sale count is null, never zero", () => {
    const result = computeGradeLadder({ totalGradedBasis: BASIS, slabValues: { 6: 400 } });
    expect(result.rungs.find((r) => r.grade === 6)!.saleCount).toBeNull();
  });
});

describe("downside protection can be measured at PSA 6", () => {
  const rungs = (values: Record<number, number | null>) =>
    computeGradeLadder({ totalGradedBasis: BASIS, slabValues: values });

  it("defaults to PSA 7, unchanged", () => {
    const result = classifyGradeEconomics(rungs({ 6: 400, 7: 450, 8: 500, 9: 700, 10: 1200 }));
    expect(result.economicClass).toBe("DOWNSIDE_PROTECTED");
    expect(result.rationale).toContain("PSA 7");
  });

  it("measures at PSA 6 when asked, and says so", () => {
    const result = classifyGradeEconomics(rungs({ 6: 400, 7: 450, 8: 500, 9: 700, 10: 1200 }), {
      ...DEFAULT_CLASSIFICATION_SETTINGS,
      downsideProtectedGrade: 6,
    });
    expect(result.economicClass).toBe("DOWNSIDE_PROTECTED");
    expect(result.rationale).toContain("PSA 6");
  });

  it("refuses to claim protection at a grade it has no price for", () => {
    const result = classifyGradeEconomics(rungs({ 6: null, 7: 450, 8: 500, 9: 700, 10: 1200 }), {
      ...DEFAULT_CLASSIFICATION_SETTINGS,
      downsideProtectedGrade: 6,
    });
    // It does NOT quietly fall back to the PSA 7 that would have passed —
    // the card is still BALANCED on its 8/9, but it is not claimed to have a
    // floor at a grade nobody has a price for.
    expect(result.satisfiedClasses).not.toContain("DOWNSIDE_PROTECTED");
    expect(result.economicClass).toBe("BALANCED");
  });

  it("a real profit bar is enforced, not just 'does not lose'", () => {
    // PSA 7 returns a few pounds — passes the old £0 bar, fails a £250 one.
    const marginal = rungs({ 6: null, 7: 120, 8: 500, 9: 700, 10: 1200 });
    expect(classifyGradeEconomics(marginal).economicClass).toBe("DOWNSIDE_PROTECTED");

    const strict = classifyGradeEconomics(marginal, {
      ...DEFAULT_CLASSIFICATION_SETTINGS,
      downsideProtectedMinPsa7Profit: 250,
    });
    expect(strict.satisfiedClasses).not.toContain("DOWNSIDE_PROTECTED");
  });

  it("explains itself when the bar is what stopped it classifying at all", () => {
    // Nothing else saves it: PSA 8 loses heavily and PSA 9 is thin, so the
    // card lands UNCLASSIFIED and the reasons are surfaced.
    const result = classifyGradeEconomics(rungs({ 6: null, 7: 120, 8: null, 9: null, 10: null }), {
      ...DEFAULT_CLASSIFICATION_SETTINGS,
      downsideProtectedMinPsa7Profit: 250,
    });
    expect(result.economicClass).toBe("UNCLASSIFIED");
    expect(result.unclassifiedReasons.join(" ")).toContain("downside-protection bar");
  });
});

describe("qualification can require profit at a low grade", () => {
  const base = {
    economicClass: "DOWNSIDE_PROTECTED" as const,
    rawAcquisitionCost: 50,
    totalGradedBasis: BASIS,
    psa10Value: 1200,
    psa10Profit: 900,
    psa10GrossMultiple: 13,
    psa9Profit: 500,
    psa8Profit: 350,
    psa7Profit: 260,
    psa6Profit: 300,
    salesBehindBuyGrade: 14,
    breakEvenGrade: 6 as const,
    requiredPsa10RateVsPsa9: 0,
    liquidity: "HIGH" as const,
    confidence: 0.8,
    estimatedCapitalLockDays: 200,
    graderId: "PSA",
    serviceId: "PSA_VALUE",
  };
  const rules = { ...DEFAULT_GRADE_QUALIFICATION, minPsa10Value: 0 };

  it("passes a £300-at-PSA-6 card against a £250 PSA 6 floor", () => {
    const result = qualifyGrade(base, { ...rules, minPsa6Profit: 250 });
    expect(result.qualifies).toBe(true);
  });

  it("fails a card that only pays at the top", () => {
    const result = qualifyGrade({ ...base, psa6Profit: -30 }, { ...rules, minPsa6Profit: 250 });
    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("minPsa6Profit");
  });

  it("fails, with a clear reason, when the grade has no price at all", () => {
    const result = qualifyGrade({ ...base, psa6Profit: null }, { ...rules, minPsa6Profit: 250 });
    expect(result.qualifies).toBe(false);
    expect(result.failures.find((f) => f.rule === "minPsa6Profit")!.reason).toContain("No PSA 6 price");
  });

  it("refuses a grade whose price stands on one sale", () => {
    const result = qualifyGrade(
      { ...base, salesBehindBuyGrade: 1 },
      { ...rules, minSalesBehindBuyGrade: 5, buyGrade: 6 },
    );
    expect(result.qualifies).toBe(false);
    const reason = result.failures.find((f) => f.rule === "minSalesBehindBuyGrade")!.reason;
    expect(reason).toContain("extrapolation, not a market");
  });

  it("lets an UNKNOWN sale count through — absent evidence is not evidence of absence", () => {
    // Every snapshot written before migration 0027 looks like this. Treating
    // it as zero would disqualify the entire existing database on deploy.
    const result = qualifyGrade(
      { ...base, salesBehindBuyGrade: null },
      { ...rules, minSalesBehindBuyGrade: 5, buyGrade: 6 },
    );
    expect(result.qualifies).toBe(true);
  });
});
