import { describe, it, expect } from "vitest";
import {
  checkCentering,
  centeringCeiling,
  centeringStandard,
  worstAxis,
  CenteringInputError,
} from "../src/deal/centeringStandards.js";

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
