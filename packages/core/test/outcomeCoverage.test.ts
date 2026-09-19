import { describe, it, expect } from "vitest";
import { assessGradeOutcomeCoverage } from "../src/grading/outcomeCoverage.js";

/**
 * THE LADDER IS NOT THE WHOLE STORY, AND MUST SAY SO.
 *
 * The operator's correction, 2026-09-19: "'Pays at PSA 5' remains
 * conditional. It is a useful downside scenario, not a guaranteed floor. The
 * purchase could return a lower grade or no numerical grade."
 *
 * The second half had no answer in the tool at all. The ladder runs PSA 1 to
 * 10 and reads as exhaustive; a submission can also come back with a
 * qualifier, as Authentic-Altered, or not encapsulated. Those were not
 * merely unquantified, they were UNMENTIONED — "worst case PSA 1" gave a
 * reader no way to tell the worst case ON THE SCALE from the worst case
 * outright.
 *
 * This matters more now than it did last week. Three changes in a row —
 * the PSA 1-10 ladder, judging eligibility at a conservative value, and
 * easing the confidence bar — all made the tool more willing to show
 * low-grade trades. This is the counterweight, and these tests are mostly
 * about what it refuses to claim.
 */
describe("the unrecoverable part of the spend", () => {
  it("is the grading cost, exactly — basis less what the card cost", () => {
    const result = assessGradeOutcomeCoverage({ totalGradedBasis: 228, rawAcquisitionCost: 200 });

    expect(result.sunkGradingCost).toBe(28);
  });

  it("never goes negative, so grading can never appear to recover money", () => {
    // A basis below the card's own cost is malformed input. A negative sunk
    // cost would read as a refund.
    const result = assessGradeOutcomeCoverage({ totalGradedBasis: 100, rawAcquisitionCost: 200 });

    expect(result.sunkGradingCost).toBe(0);
  });
});

describe("what a card returned unencapsulated costs", () => {
  it("is the whole spend less what the raw card might still fetch", () => {
    const result = assessGradeOutcomeCoverage({
      totalGradedBasis: 228,
      rawAcquisitionCost: 200,
      rawResaleValue: 180,
    });

    expect(result.bestCaseIfNotEncapsulated).toBe(-48);
  });

  /**
   * An unknown bound is not a bound. Substituting zero would state that the
   * returned card is worthless, which is a claim about a card nobody has
   * looked at.
   */
  it("is null when no raw value is known, rather than assuming zero", () => {
    for (const raw of [null, undefined, 0, -5, Number.NaN]) {
      const result = assessGradeOutcomeCoverage({ totalGradedBasis: 228, rawAcquisitionCost: 200, rawResaleValue: raw });

      expect(result.bestCaseIfNotEncapsulated).toBeNull();
    }
  });

  it("is labelled a BEST case, because selling the returned card costs more on top", () => {
    const result = assessGradeOutcomeCoverage({
      totalGradedBasis: 228,
      rawAcquisitionCost: 200,
      rawResaleValue: 180,
    });

    expect(result.summary).toContain("at best");
  });
});

describe("it names the outcomes rather than leaving them to be inferred from silence", () => {
  it("covers qualifiers, altered, and not encapsulated", () => {
    const outcomes = assessGradeOutcomeCoverage({ totalGradedBasis: 228, rawAcquisitionCost: 200 }).notes.map(
      (n) => n.outcome,
    );

    expect(outcomes).toEqual(["QUALIFIER", "AUTHENTIC_ALTERED", "NOT_ENCAPSULATED"]);
  });

  it("is explicit that the two it cannot price are unpriced", () => {
    const notes = assessGradeOutcomeCoverage({ totalGradedBasis: 228, rawAcquisitionCost: 200 }).notes;

    expect(notes.find((n) => n.outcome === "QUALIFIER")!.unpriced).toBe(true);
    expect(notes.find((n) => n.outcome === "AUTHENTIC_ALTERED")!.unpriced).toBe(true);
  });

  it("says the ladder assumes a CLEAN grade, which is the quiet assumption in every rung", () => {
    const summary = assessGradeOutcomeCoverage({ totalGradedBasis: 228, rawAcquisitionCost: 200 }).summary;

    expect(summary).toContain("CLEAN grade");
    expect(summary).toContain("PSA 1 to 10");
  });
});

/**
 * THE LINE THAT MUST NOT MOVE. The moment this starts saying "about 3% come
 * back altered" it has invented the first probability in the tool, and every
 * figure downstream inherits a number nobody measured.
 */
describe("it does not estimate how often any of this happens", () => {
  it("states plainly that the frequency is not estimated", () => {
    const summary = assessGradeOutcomeCoverage({ totalGradedBasis: 228, rawAcquisitionCost: 200 }).summary;

    expect(summary).toContain("not estimated");
  });

  it("carries no rate, percentage or likelihood anywhere in its output", () => {
    const result = assessGradeOutcomeCoverage({
      totalGradedBasis: 228,
      rawAcquisitionCost: 200,
      rawResaleValue: 180,
    });
    const text = JSON.stringify(result);

    expect(text).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(text.toLowerCase()).not.toContain("probability");
    expect(text.toLowerCase()).not.toContain("likelihood");
    expect(text.toLowerCase()).not.toContain("expected");
  });

  it("returns the same notes regardless of the card, since nothing here is card-specific", () => {
    const cheap = assessGradeOutcomeCoverage({ totalGradedBasis: 40, rawAcquisitionCost: 12 });
    const dear = assessGradeOutcomeCoverage({ totalGradedBasis: 1028, rawAcquisitionCost: 1000 });

    // If these ever diverge, something has started inferring risk from price.
    expect(cheap.notes).toEqual(dear.notes);
  });
});
