import { describe, it, expect } from "vitest";
import {
  assessGradeLadderPlausibility,
  DEFAULT_MAX_PSA10_OVER_PSA9,
  type SlabLadder,
} from "../src/opportunity/gradeLadderPlausibility.js";

/**
 * MEASURED ON THE LIVE DATABASE, 2026-09-18, across 12,747 active qualified
 * GRADE opportunities — the rows the operator was actually being shown:
 *
 *   ladder runs backwards somewhere ......  3,484  (27%)
 *   PSA 10 more than 10x its own PSA 9 ...  6,763  (53%)
 *
 * And on the 141 live sub-£30 listings that broke even at PSA 6 — the exact
 * trade being hunted — the average claimed PSA 10 was £3,055 on a £17 card
 * in the mildest band and £31,922 on a £19.55 card in the worst. He passed
 * 138 of the 141 by hand. The tool had no way to tell him why.
 */
describe("a ladder that runs backwards", () => {
  it("catches a PSA 9 priced above the PSA 10", () => {
    const result = assessGradeLadderPlausibility({ 6: 20, 7: 40, 8: 80, 9: 500, 10: 300 });

    expect(result.implausible).toBe(true);
    expect(result.findings.map((f) => f.kind)).toContain("LADDER_INVERTED");
    expect(result.reason).toContain("PSA 10");
    expect(result.reason).toContain("PSA 9");
  });

  it("catches an inversion low on the ladder too, not just at the top", () => {
    const result = assessGradeLadderPlausibility({ 6: 90, 7: 40, 8: 80, 9: 200, 10: 600 });

    expect(result.implausible).toBe(true);
    expect(result.findings.filter((f) => f.kind === "LADDER_INVERTED")).toHaveLength(1);
  });

  it("reports every inversion, because one fix may not be the only problem", () => {
    const result = assessGradeLadderPlausibility({ 6: 90, 7: 40, 8: 80, 9: 500, 10: 300 });

    expect(result.findings.filter((f) => f.kind === "LADDER_INVERTED")).toHaveLength(2);
  });

  it("needs no threshold to do it — an inversion is proof, not a judgement", () => {
    // One penny the wrong way is still impossible, and the assessment does
    // not soften because the gap is small. If this ever starts tolerating a
    // margin, that margin is a licence for exactly the data faults this was
    // written to catch.
    expect(assessGradeLadderPlausibility({ 9: 100.01, 10: 100 }).implausible).toBe(true);
  });

  it("passes a ladder that only ever goes up", () => {
    const result = assessGradeLadderPlausibility({ 6: 20, 7: 35, 8: 60, 9: 140, 10: 480 });

    expect(result.implausible).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.reason).toBeNull();
  });

  it("treats equal adjacent tiers as fine — a flat step is not a backwards one", () => {
    expect(assessGradeLadderPlausibility({ 8: 60, 9: 60, 10: 200 }).implausible).toBe(false);
  });
});

describe("the PSA 10 jump", () => {
  it("flags the shape that filled the feed — a thin top tier owning the row", () => {
    // The Pikachu EX XY124 payload as it actually arrived: PSA 9 at 5,110
    // against a PSA 10 of 88,988, which is 17x and was the number driving a
    // "protected" grading recommendation.
    const result = assessGradeLadderPlausibility({ 9: 5110, 10: 88988 });

    expect(result.implausible).toBe(true);
    expect(result.findings.map((f) => f.kind)).toContain("PSA10_JUMP_IMPLAUSIBLE");
    expect(result.psa10OverPsa9).toBeCloseTo(17.4, 1);
  });

  it("leaves a steep but real jump alone", () => {
    // 5x is an ordinary PSA 9 -> PSA 10 step and must not be touched, or the
    // rule removes the entire premise of grading for profit.
    const result = assessGradeLadderPlausibility({ 9: 140, 10: 700 });

    expect(result.implausible).toBe(false);
    expect(result.psa10OverPsa9).toBe(5);
  });

  it("sits exactly where the default says it does", () => {
    expect(assessGradeLadderPlausibility({ 9: 100, 10: 100 * DEFAULT_MAX_PSA10_OVER_PSA9 }).implausible).toBe(false);
    expect(assessGradeLadderPlausibility({ 9: 100, 10: 100 * DEFAULT_MAX_PSA10_OVER_PSA9 + 1 }).implausible).toBe(true);
  });

  it("is tunable, because the right number is the operator's call", () => {
    const ladder: SlabLadder = { 9: 100, 10: 1500 };

    expect(assessGradeLadderPlausibility(ladder, 10).implausible).toBe(true);
    expect(assessGradeLadderPlausibility(ladder, 20).implausible).toBe(false);
  });
});

/**
 * BLANK IS NOT ZERO. Every one of these would, under a £0 reading, either
 * invent an inversion or invent an infinite multiple — and each would remove
 * a real card from the feed on the strength of a measurement nobody took.
 */
describe("missing tiers are missing, not zero", () => {
  it("says nothing about a ladder with no data at all", () => {
    const result = assessGradeLadderPlausibility({});

    expect(result.implausible).toBe(false);
    expect(result.psa10OverPsa9).toBeNull();
    expect(result.reason).toBeNull();
  });

  it("does not read an absent middle rung as a crash to zero", () => {
    // 8 is unknown. Under a zero reading this is 60 -> 0 -> 200: two
    // inversions out of thin air.
    const result = assessGradeLadderPlausibility({ 7: 60, 8: null, 9: 200, 10: 600 });

    expect(result.implausible).toBe(false);
  });

  it("cannot compute the jump without both tiers, and does not guess", () => {
    expect(assessGradeLadderPlausibility({ 9: 200, 10: null }).psa10OverPsa9).toBeNull();
    expect(assessGradeLadderPlausibility({ 9: null, 10: 9999 }).psa10OverPsa9).toBeNull();
    expect(assessGradeLadderPlausibility({ 9: null, 10: 9999 }).implausible).toBe(false);
  });

  it("ignores a zero or negative price rather than treating it as a real one", () => {
    // A provider returning 0 has told us nothing, and £0 at PSA 9 would make
    // every PSA 10 above it an infinite multiple.
    expect(assessGradeLadderPlausibility({ 9: 0, 10: 500 }).implausible).toBe(false);
    expect(assessGradeLadderPlausibility({ 9: -5, 10: 500 }).implausible).toBe(false);
  });
});

describe("what it says to the operator", () => {
  it("names the contradiction with both figures, not a vague warning", () => {
    const reason = assessGradeLadderPlausibility({ 9: 500, 10: 300 }).reason ?? "";

    expect(reason).toContain("£500.00");
    expect(reason).toContain("£300.00");
  });

  it("does not call the listing bad — the doubt is about our own data", () => {
    const reason = assessGradeLadderPlausibility({ 9: 500, 10: 300 }).reason ?? "";

    expect(reason.toLowerCase()).toContain("contradict themselves");
    expect(reason.toLowerCase()).toContain("not trustworthy");
    expect(reason.toLowerCase()).toContain("nothing here says the listing is bad");
  });

  it("reports both faults at once when both are present", () => {
    // Inverted at the bottom AND an impossible jump at the top. Reporting
    // only the first would suggest one bad tier when there are two.
    const result = assessGradeLadderPlausibility({ 6: 90, 7: 40, 9: 100, 10: 5000 });

    expect(result.findings.map((f) => f.kind).sort()).toEqual(["LADDER_INVERTED", "PSA10_JUMP_IMPLAUSIBLE"]);
  });
});
