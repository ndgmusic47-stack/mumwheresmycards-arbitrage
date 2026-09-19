import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIDENCE_BAR, requiredGradeConfidence } from "../src/market/confidenceBar.js";
import { computeGradeProfile } from "../src/market/gradeProfile.js";
import { DEFAULT_MARKET_PROFILE_SETTINGS } from "../src/market/types.js";
import type { ProfileSnapshotInput } from "../src/market/types.js";

/**
 * THE BAR THAT REJECTED CARDS FOR BEING SCARCE.
 *
 * Confidence is a 0-1 trust score on a card's price data, derived from sale
 * counts where the provider gives none: 20 sales scores 1.0, so the flat
 * 0.4 bar was "at least about eight recorded sales".
 *
 * Measured live 2026-09-19: roughly 1,900 catalogued cards excluded by it,
 * 1,174 of them at exactly 0.35 — seven sales, one notch under a line
 * nobody chose against evidence. Eight sales is a fair ask of a £6 card and
 * close to nonsense for a £600 one, where few sales IS scarcity. The bar was
 * therefore hardest on precisely the cards this business is moving towards,
 * and it failed them silently: a card refused here never enters the eBay
 * search universe, so no listing for it is priced and nothing reports a near
 * miss.
 */
describe("the required confidence eases as a card gets more valuable", () => {
  it("holds the full bar for a cheap card", () => {
    expect(requiredGradeConfidence(6)).toBe(DEFAULT_CONFIDENCE_BAR.atLowValue);
    expect(requiredGradeConfidence(DEFAULT_CONFIDENCE_BAR.pivotLowValue)).toBe(DEFAULT_CONFIDENCE_BAR.atLowValue);
  });

  it("reaches the relaxed bar for an expensive one", () => {
    expect(requiredGradeConfidence(DEFAULT_CONFIDENCE_BAR.pivotHighValue)).toBe(DEFAULT_CONFIDENCE_BAR.atHighValue);
    expect(requiredGradeConfidence(5000)).toBe(DEFAULT_CONFIDENCE_BAR.atHighValue);
  });

  it("moves smoothly in between — no cliff a penny either side of a pivot", () => {
    const justInside = requiredGradeConfidence(DEFAULT_CONFIDENCE_BAR.pivotLowValue + 0.01);
    const justOutside = requiredGradeConfidence(DEFAULT_CONFIDENCE_BAR.pivotLowValue - 0.01);

    expect(Math.abs(justInside - justOutside)).toBeLessThan(0.001);
  });

  it("never demands MORE of a dearer card — a card must not clear the bar by getting cheaper", () => {
    let previous = Infinity;
    for (const value of [5, 25, 50, 100, 200, 300, 500, 1000, 5000]) {
      const required = requiredGradeConfidence(value);
      expect(required).toBeLessThanOrEqual(previous);
      previous = required;
    }
  });

  /**
   * Not knowing what a card is worth is not a reason to trust its data more.
   */
  it("applies the strict bar when the value is unknown or nonsense", () => {
    for (const bad of [null, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(requiredGradeConfidence(bad as number | null)).toBe(DEFAULT_CONFIDENCE_BAR.atLowValue);
    }
  });

  it("falls back to the strict bar on a misconfigured pivot range rather than dividing by zero", () => {
    const degenerate = { atLowValue: 0.4, atHighValue: 0.2, pivotLowValue: 100, pivotHighValue: 100 };
    const inverted = { atLowValue: 0.4, atHighValue: 0.2, pivotLowValue: 500, pivotHighValue: 50 };

    expect(Number.isFinite(requiredGradeConfidence(300, degenerate))).toBe(true);
    expect(Number.isFinite(requiredGradeConfidence(300, inverted))).toBe(true);
  });
});

function snapshot(over: Partial<ProfileSnapshotInput> = {}): ProfileSnapshotInput {
  return {
    rawMarketPrice: 600,
    rawMedian7d: 560,
    rawMedian30d: 570,
    rawQsv: 520,
    psa6: 900,
    psa7: 1100,
    psa8: 1500,
    psa9: 2400,
    psa10: 5000,
    // Seven recorded sales. The exact figure 1,174 live cards sit at.
    confidence: 0.35,
    liquidity: "MEDIUM",
    sampleSize: 7,
    ...over,
  };
}

describe("the gate, end to end", () => {
  it("admits a scarce expensive card that the flat bar refused", () => {
    const result = computeGradeProfile(snapshot({ rawMarketPrice: 600, confidence: 0.35 }));

    // Not merely "not rejected for confidence" — it clears the gate outright,
    // which is the point. 0.35 is the exact figure 1,174 live cards sit at.
    expect(result.eligible).toBe(true);
    expect(result.ineligibleReason).toBeNull();
  });

  it("still refuses the SAME thin evidence on a cheap card", () => {
    // Identical confidence, identical sale count — only the card's value
    // differs, and at £20 seven sales really is thin.
    const result = computeGradeProfile(
      snapshot({ rawMarketPrice: 20, rawQsv: 18, confidence: 0.35, psa6: 40, psa7: 50, psa8: 70, psa9: 110, psa10: 260 }),
    );

    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toContain("confidence");
  });

  it("says what was required and why, not just that it failed", () => {
    const result = computeGradeProfile(snapshot({ rawMarketPrice: 20, rawQsv: 18, confidence: 0.1 }));

    // A bare "below the minimum" sends the reader to the wrong setting when
    // the minimum is no longer one number.
    expect(result.ineligibleReason).toContain("required");
    expect(result.ineligibleReason).toContain("value");
  });

  it("still refuses a card with almost no evidence at all, at any price", () => {
    const result = computeGradeProfile(snapshot({ rawMarketPrice: 5000, confidence: 0.05 }));

    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toContain("confidence");
  });

  it("keeps the existing setting in charge of the cheap end", () => {
    // Raising minGradeConfidence must still bite, or the old control has
    // silently become decorative.
    const strict = { ...DEFAULT_MARKET_PROFILE_SETTINGS, minGradeConfidence: 0.9 };
    const result = computeGradeProfile(snapshot({ rawMarketPrice: 20, rawQsv: 18, confidence: 0.5 }), strict);

    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toContain("confidence");
  });
});
