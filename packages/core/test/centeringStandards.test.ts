import { describe, it, expect } from "vitest";
import {
  checkCentering,
  centeringCeiling,
  centeringStandard,
  worstAxis,
  CenteringInputError,
  CENTERING_STANDARDS,
} from "../src/deal/centeringStandards.js";
import { graderScale } from "../src/deal/graderScales.js";

/**
 * These test the ONE thing a photograph can establish about a grade with
 * evidence rather than opinion, and — more importantly — they test all the
 * things it must refuse to establish.
 *
 * The dangerous failure here is not a wrong ceiling. It is a confident one:
 * a tool that says "PSA 10" because the front looked centred, having never
 * seen the back, the corners or the surface.
 */
describe("centering rules grades OUT, never IN", () => {
  it("a badly centred front rules out the grades it exceeds", () => {
    // 65/35 front: past PSA 10 (55) and PSA 9 (60), inside PSA 8 (70).
    const checks = checkCentering("PSA", { leftRightPct: 65, topBottomPct: 52 }, null);
    const byKey = Object.fromEntries(checks.map((c) => [c.gradeKey, c.verdict]));
    expect(byKey.PSA_10).toBe("EXCEEDS");
    expect(byKey.PSA_9).toBe("EXCEEDS");
    expect(byKey.PSA_8).toBe("WITHIN");
    expect(centeringCeiling(checks)!.gradeKey).toBe("PSA_8");
  });

  it("the WORSE axis decides — a card is not saved by its good axis", () => {
    expect(worstAxis({ leftRightPct: 51, topBottomPct: 68 })).toBe(68);
    const checks = checkCentering("PSA", { leftRightPct: 51, topBottomPct: 68 }, null);
    expect(checks.find((c) => c.gradeKey === "PSA_9")!.verdict).toBe("EXCEEDS");
  });

  it("a perfectly centred card is WITHIN the top grade but is NOT predicted to get it", () => {
    const checks = checkCentering("PSA", { leftRightPct: 50, topBottomPct: 50 }, null);
    const top = checks.find((c) => c.gradeKey === "PSA_10")!;
    // "WITHIN" is the strongest thing centering can say, and it is a
    // statement about centering only.
    expect(top.verdict).toBe("WITHIN");
    expect(centeringCeiling(checks)!.gradeKey).toBe("PSA_10");
  });

  it("reports NOT_ASSESSED, never a pass, when there is no measurement at all", () => {
    const checks = checkCentering("PSA", null, null);
    expect(checks.every((c) => c.verdict === "NOT_ASSESSED")).toBe(true);
    expect(centeringCeiling(checks)).toBeNull();
  });
});

describe("no grader is given a standard it does not publish", () => {
  it("PSA carries NO back tolerance, so a bad back cannot rule a PSA grade out", () => {
    // PSA publishes no reverse figure anywhere. The popular "75/25 back" is
    // third-party. A terrible back must therefore leave the PSA verdict
    // untouched rather than be judged against a number PSA never stated.
    const checks = checkCentering("PSA", { leftRightPct: 50, topBottomPct: 50 }, { leftRightPct: 95, topBottomPct: 95 });
    expect(checks.find((c) => c.gradeKey === "PSA_10")!.verdict).toBe("WITHIN");
    expect(centeringStandard("PSA")!.tolerances.every((t) => t.backMaxPct === null)).toBe(true);
  });

  it("CGC DOES publish a back tolerance, and it is applied", () => {
    // CGC Gem Mint 10: 55/45 front, 75/25 reverse. A 95/5 back exceeds it.
    const checks = checkCentering("CGC", { leftRightPct: 50, topBottomPct: 50 }, { leftRightPct: 95, topBottomPct: 50 });
    const gemMint = checks.find((c) => c.gradeKey === "CGC_GEM_MINT_10")!;
    expect(gemMint.verdict).toBe("EXCEEDS");
    expect(gemMint.decidedBy).toBe("BACK");
  });

  it("CGC 9.5 has no published tolerance and is never assessed", () => {
    // Mint+ is an explicit subjective eye-appeal bump. Interpolating it
    // between 9 and 10 would be inventing a CGC standard.
    const checks = checkCentering("CGC", { leftRightPct: 50, topBottomPct: 50 }, null);
    expect(checks.find((c) => c.gradeKey === "CGC_9_5")!.verdict).toBe("NOT_ASSESSED");
  });

  it("uses PSA's own glossary figures, not the popular third-party table", () => {
    // The widely-copied table says PSA 8 = 65/35. PSA's own words are 70/30.
    const psa8 = centeringStandard("PSA")!.tolerances.find((t) => t.gradeKey === "PSA_8")!;
    expect(psa8.frontMaxPct).toBe(70);
    const psa7 = centeringStandard("PSA")!.tolerances.find((t) => t.gradeKey === "PSA_7")!;
    expect(psa7.frontMaxPct).toBe(75);
  });

  it("flags that PSA's figures come from a glossary, not a standards page", () => {
    expect(centeringStandard("PSA")!.fromFormalStandard).toBe(false);
    expect(centeringStandard("CGC")!.fromFormalStandard).toBe(true);
  });

  it("returns nothing for a grader with no published scale rather than guessing", () => {
    expect(checkCentering("BGS", { leftRightPct: 50, topBottomPct: 50 }, null)).toEqual([]);
    expect(centeringStandard("BGS")).toBeNull();
  });
});

describe("measurements are validated, not coerced", () => {
  it("rejects a value below 50 instead of flipping it to the larger share", () => {
    // 40 probably means 60 the other way, but silently 'correcting' the
    // caller is how a measurement ends up meaning the opposite of itself.
    expect(() => checkCentering("PSA", { leftRightPct: 40, topBottomPct: 50 }, null)).toThrow(CenteringInputError);
  });

  it("rejects non-finite and out-of-range values", () => {
    expect(() => checkCentering("PSA", { leftRightPct: NaN, topBottomPct: 50 }, null)).toThrow(CenteringInputError);
    expect(() => checkCentering("PSA", { leftRightPct: 140, topBottomPct: 50 }, null)).toThrow(CenteringInputError);
  });

  it("accepts the exact boundary — 55/45 is WITHIN PSA 10, not outside it", () => {
    // "no worse than 55-45" includes 55.
    const checks = checkCentering("PSA", { leftRightPct: 55, topBottomPct: 55 }, null);
    expect(checks.find((c) => c.gradeKey === "PSA_10")!.verdict).toBe("WITHIN");
    const past = checkCentering("PSA", { leftRightPct: 55.1, topBottomPct: 50 }, null);
    expect(past.find((c) => c.gradeKey === "PSA_10")!.verdict).toBe("EXCEEDS");
  });
});

/**
 * SGC AND TAG — the two graders PokeTrace actually returns prices for, and
 * whose standards differ from PSA's and CGC's in ways that matter.
 *
 * These tests exist mostly to pin down the ABSENCES. SGC omits a centering
 * figure for every "+" half grade; TAG stops publishing a back tolerance
 * below grade 8. Both gaps are easy to "helpfully" fill by interpolation,
 * and doing so would attribute a standard to a grader that never set one.
 */
describe("SGC", () => {
  it("publishes no back tolerance anywhere, so a bad back cannot rule out an SGC grade", () => {
    expect(centeringStandard("SGC")!.tolerances.every((t) => t.backMaxPct === null)).toBe(true);
    const checks = checkCentering("SGC", { leftRightPct: 50, topBottomPct: 50 }, { leftRightPct: 99, topBottomPct: 99 });
    expect(checks.find((c) => c.gradeKey === "SGC_PRISTINE_10")!.verdict).toBe("WITHIN");
  });

  it("has two tens, and Pristine is stricter than GEM", () => {
    const pristine = centeringStandard("SGC")!.tolerances.find((t) => t.gradeKey === "SGC_PRISTINE_10")!;
    const gem = centeringStandard("SGC")!.tolerances.find((t) => t.gradeKey === "SGC_GEM_10")!;
    expect(pristine.frontMaxPct).toBe(50);
    expect(gem.frontMaxPct).toBe(55);
  });

  it("leaves every '+' half grade unassessed rather than interpolating one", () => {
    // SGC defines these as eye-appeal steps, not centering thresholds.
    const checks = checkCentering("SGC", { leftRightPct: 52, topBottomPct: 52 }, null);
    for (const key of ["SGC_9_5", "SGC_6_5", "SGC_5_5", "SGC_4_5", "SGC_3_5", "SGC_2_5"]) {
      expect(checks.find((c) => c.gradeKey === key)!.verdict).toBe("NOT_ASSESSED");
    }
  });

  it("does not pretend centering separates rungs that share a tolerance", () => {
    // 8.5 and 8 both allow 65/35; 7.5 and 7 both allow 70/30.
    const t = centeringStandard("SGC")!.tolerances;
    expect(t.find((x) => x.gradeKey === "SGC_8_5")!.frontMaxPct).toBe(t.find((x) => x.gradeKey === "SGC_8")!.frontMaxPct);
    expect(t.find((x) => x.gradeKey === "SGC_7_5")!.frontMaxPct).toBe(t.find((x) => x.gradeKey === "SGC_7")!.frontMaxPct);
  });
});

describe("TAG", () => {
  it("uses TAG's TCG back figures, not its Sports ones — this app is Pokémon", () => {
    // At Gem Mint 10 TAG allows ~70/30 on a Sports back but only ~65/35 on a
    // TCG back. Using the Sports figure would wave through a card TAG fails.
    const gem = centeringStandard("TAG")!.tolerances.find((t) => t.gradeKey === "TAG_GEM_MINT_10")!;
    expect(gem.backMaxPct).toBe(65);
    expect(gem.frontMaxPct).toBe(55);
  });

  it("applies the back tolerance where TAG publishes one", () => {
    const checks = checkCentering("TAG", { leftRightPct: 50, topBottomPct: 50 }, { leftRightPct: 80, topBottomPct: 50 });
    const gem = checks.find((c) => c.gradeKey === "TAG_GEM_MINT_10")!;
    expect(gem.verdict).toBe("EXCEEDS");
    expect(gem.decidedBy).toBe("BACK");
  });

  it("stops using the back below grade 8, where TAG stops publishing one", () => {
    // From 7.5 down the rule becomes qualitative ("no miscut"), which a
    // border measurement cannot test.
    const checks = checkCentering("TAG", { leftRightPct: 50, topBottomPct: 50 }, { leftRightPct: 99, topBottomPct: 99 });
    for (const key of ["TAG_7_5", "TAG_7", "TAG_6", "TAG_5"]) {
      expect(checks.find((c) => c.gradeKey === key)!.verdict).toBe("WITHIN");
    }
    // But grade 8 still has one, and 99/1 exceeds its ~95/5.
    expect(checks.find((c) => c.gradeKey === "TAG_8")!.verdict).toBe("EXCEEDS");
  });

  it("carries TAG's half-grade front figures, which no other grader publishes", () => {
    const t = centeringStandard("TAG")!.tolerances;
    expect(t.find((x) => x.gradeKey === "TAG_8_5")!.frontMaxPct).toBe(62.5);
    expect(t.find((x) => x.gradeKey === "TAG_6_5")!.frontMaxPct).toBe(72.5);
  });

  it("omits Poor 1, for which TAG publishes no front figure", () => {
    expect(centeringStandard("TAG")!.tolerances.find((t) => t.gradeKey === "TAG_1")).toBeUndefined();
  });
});

describe("all four graders are internally consistent", () => {
  it("every tolerance names a rung that exists on that grader's scale", () => {
    for (const [graderId, standard] of Object.entries(CENTERING_STANDARDS)) {
      const scale = graderScale(graderId)!;
      for (const tolerance of standard.tolerances) {
        expect(scale.rungs.some((r) => r.key === tolerance.gradeKey)).toBe(true);
      }
    }
  });

  it("tolerances never get stricter as the grade falls", () => {
    for (const standard of Object.values(CENTERING_STANDARDS)) {
      const scale = graderScale(standard.graderId)!;
      const ordered = scale.rungs
        .map((r) => standard.tolerances.find((t) => t.gradeKey === r.key))
        .filter((t): t is NonNullable<typeof t> => t !== undefined);
      for (let i = 1; i < ordered.length; i += 1) {
        expect(ordered[i]!.frontMaxPct).toBeGreaterThanOrEqual(ordered[i - 1]!.frontMaxPct);
      }
    }
  });
});
