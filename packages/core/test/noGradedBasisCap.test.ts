import { describe, it, expect } from "vitest";
import { qualifyGrade } from "../src/filters/predicates.js";
import { DEFAULT_GRADE_QUALIFICATION } from "../src/filters/types.js";
import type { GradeQualificationInput, GradeQualificationRules } from "../src/filters/types.js";

/**
 * REMOVING THE £1,500 ALL-IN CAP — 2026-09-19, "remove it, I don't need it."
 *
 * It capped card + postage + grading fee + batch share at £1,500, and it sat
 * behind maxRawAcquisitionCost (£1,000), which is the ceiling the operator
 * actually steers with. Two ceilings on the same decision, one of them
 * unchosen: a £1,000 card that clears the raw limit deliberately could still
 * be removed by a figure nobody set.
 *
 * The rule itself is kept and still works — it is now NULL by default,
 * meaning no cap. Null is a real absence, so the check is skipped rather
 * than passed. That distinction is the point of most of this file: a
 * qualification report that says "within cap" against a cap nobody set is
 * how a rule comes to look enforced when it is not.
 */
function rules(over: Partial<GradeQualificationRules> = {}): GradeQualificationRules {
  return { ...DEFAULT_GRADE_QUALIFICATION, ...over };
}

/** A candidate that clears everything else, so only the cap is under test. */
function input(over: Partial<GradeQualificationInput> = {}): GradeQualificationInput {
  return {
    economicClass: "DOWNSIDE_PROTECTED",
    rawAcquisitionCost: 400,
    totalGradedBasis: 430,
    psa10Value: 3000,
    psa6Profit: 200,
    psa7Profit: 300,
    psa8Profit: 600,
    psa9Profit: 1200,
    psa10Profit: 2200,
    psa10GrossMultiple: 7,
    breakEvenGrade: 6,
    requiredPsa10RateVsPsa9: 0.2,
    liquidity: "HIGH",
    confidence: 0.8,
    estimatedCapitalLockDays: 90,
    graderId: "PSA",
    serviceId: "PSA_STANDARD",
    salesBehindBuyGrade: 30,
    ...over,
  } as GradeQualificationInput;
}

describe("the default no longer caps total exposure", () => {
  it("ships with no cap at all", () => {
    expect(DEFAULT_GRADE_QUALIFICATION.maxTotalGradedBasis).toBeNull();
  });

  /**
   * The trade the cap used to block, in the operator's own terms: a £600
   * card that makes money low on the grade scale. All-in it is about £630 —
   * comfortably under the old £1,500 — but the same shape at £1,200 raw was
   * not, and that is the half of his stated range that was unreachable.
   */
  it("qualifies a premium card whose all-in cost is over the old £1,500", () => {
    const result = qualifyGrade(input({ rawAcquisitionCost: 950, totalGradedBasis: 1980 }), rules());

    expect(result.qualifies).toBe(true);
    expect(result.failures.map((f) => f.rule)).not.toContain("maxTotalGradedBasis");
  });

  it("does not record a cap it never applied", () => {
    const result = qualifyGrade(input({ totalGradedBasis: 99999 }), rules());

    // Absent from BOTH sides of the report — not a silent pass. `passed` is
    // a list of human-readable descriptions, so the assertion is on the
    // sentence this rule would have contributed.
    expect(result.passed.some((p) => p.startsWith("Graded basis"))).toBe(false);
    expect(result.failures.map((f) => f.rule)).not.toContain("maxTotalGradedBasis");
  });
});

describe("the rule still works when a cap is set", () => {
  it("fails a candidate over an explicit cap", () => {
    const result = qualifyGrade(input({ totalGradedBasis: 1600 }), rules({ maxTotalGradedBasis: 1500 }));

    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("maxTotalGradedBasis");
  });

  it("passes — and says so — when a cap is set and met", () => {
    const result = qualifyGrade(input({ totalGradedBasis: 430 }), rules({ maxTotalGradedBasis: 1500 }));

    expect(result.qualifies).toBe(true);
    expect(result.passed).toContain("Graded basis £430.00 within cap");
  });

  it("treats the boundary as inclusive, unchanged", () => {
    const result = qualifyGrade(input({ totalGradedBasis: 1500 }), rules({ maxTotalGradedBasis: 1500 }));

    expect(result.failures.map((f) => f.rule)).not.toContain("maxTotalGradedBasis");
  });

  /**
   * Zero is a cap of zero, not an absent one. If this ever starts behaving
   * like null, an operator who typed 0 meaning "stop everything" would get
   * the opposite.
   */
  it("does not confuse a cap of zero with no cap", () => {
    const result = qualifyGrade(input({ totalGradedBasis: 430 }), rules({ maxTotalGradedBasis: 0 }));

    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("maxTotalGradedBasis");
  });
});

describe("the other ceiling is untouched", () => {
  it("still refuses a raw price over the limit the operator does steer with", () => {
    const result = qualifyGrade(input({ rawAcquisitionCost: 1200 }), rules());

    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("maxRawAcquisitionCost");
  });

  it("keeps that limit at £1,000", () => {
    expect(DEFAULT_GRADE_QUALIFICATION.maxRawAcquisitionCost).toBe(1000);
  });
});
