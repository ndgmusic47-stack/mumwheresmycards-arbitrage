import { describe, it, expect } from "vitest";
import { computeFlipProfile } from "../src/market/flipProfile.js";
import { computeGradeProfile } from "../src/market/gradeProfile.js";
import type { ProfileSnapshotInput } from "../src/market/types.js";
import { DEFAULT_FEE_SCHEDULE } from "../src/calc/types.js";

const globalFilters = { minNetProfit: 50, minReturnOnCapital: 0.35 };

function snapshot(overrides: Partial<ProfileSnapshotInput> = {}): ProfileSnapshotInput {
  return {
    rawMarketPrice: 200,
    rawQsv: 180,
    psa7: 220,
    psa8: 260,
    psa9: 340,
    psa10: 900,
    confidence: 0.8,
    liquidity: "HIGH",
    sampleSize: 20,
    ...overrides,
  };
}

describe("computeFlipProfile", () => {
  it("is eligible for a liquid, high-confidence card with a healthy QSV and produces a positive acquisition ceiling", () => {
    const result = computeFlipProfile(snapshot(), globalFilters);
    expect(result.eligible).toBe(true);
    expect(result.maxProfitableAcquisitionPrice).not.toBeNull();
    expect(result.maxProfitableAcquisitionPrice!).toBeGreaterThan(0);
    expect(result.flipMarketScore).not.toBeNull();
  });

  it("is ineligible when QSV is below the minimum flip floor ('I don't care about £8 or £12 flips')", () => {
    const result = computeFlipProfile(snapshot({ rawQsv: 10, rawMarketPrice: 12 }), globalFilters, {
      minFlipRawValue: 20,
      minFlipLiquidity: "LOW",
      minFlipConfidence: 0.4,
      minGradeRawValue: 5,
      minGradeConfidence: 0.4,
      maxAcceptableBreakEvenGradeForEligibility: 10,
    });
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toMatch(/minimum flip floor/);
  });

  it("is ineligible below the minimum liquidity threshold", () => {
    const result = computeFlipProfile(snapshot({ liquidity: "LOW" }), globalFilters, {
      minFlipRawValue: 5,
      minFlipLiquidity: "MEDIUM",
      minFlipConfidence: 0.4,
      minGradeRawValue: 5,
      minGradeConfidence: 0.4,
      maxAcceptableBreakEvenGradeForEligibility: 10,
    });
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toMatch(/Liquidity/);
  });

  it("is ineligible below the minimum confidence threshold", () => {
    const result = computeFlipProfile(snapshot({ confidence: 0.1 }), globalFilters);
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toMatch(/confidence/);
  });

  it("is ineligible with no usable price data", () => {
    const result = computeFlipProfile(snapshot({ rawQsv: null, rawMarketPrice: null }), globalFilters);
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toMatch(/No usable raw market\/QSV price/);
  });

  it("respects a very high minNetProfit filter by producing a zero/negative acquisition ceiling", () => {
    const result = computeFlipProfile(snapshot({ rawQsv: 15, rawMarketPrice: 15 }), { minNetProfit: 5000, minReturnOnCapital: 0.35 });
    expect(result.eligible).toBe(false);
    expect(result.maxProfitableAcquisitionPrice).toBe(0);
  });
});

describe("computeGradeProfile", () => {
  it("is eligible for a card with strong PSA9/PSA10 upside relative to its raw value", () => {
    const result = computeGradeProfile(snapshot());
    expect(result.eligible).toBe(true);
    expect(result.breakEvenGrade).not.toBeNull();
    expect(result.gradeMarketScore).not.toBeNull();
    expect(result.referenceGradedBasis).toBeGreaterThan(0);
  });

  it("is ineligible when there is no PSA9/PSA10 data at all", () => {
    const result = computeGradeProfile(snapshot({ psa9: null, psa10: null }));
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toMatch(/No PSA9\/PSA10/);
  });

  it("is ineligible when raw market value is below the grading floor", () => {
    const result = computeGradeProfile(snapshot({ rawMarketPrice: 2 }), {
      minFlipRawValue: 5,
      minFlipLiquidity: "LOW",
      minFlipConfidence: 0.4,
      minGradeRawValue: 10,
      minGradeConfidence: 0.4,
      maxAcceptableBreakEvenGradeForEligibility: 10,
    });
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toMatch(/grading floor/);
  });

  it("is ineligible when the break-even grade is worse than the acceptable maximum", () => {
    // Very low PSA prices relative to raw value => a high/no break-even grade.
    const result = computeGradeProfile(
      snapshot({ rawMarketPrice: 500, psa7: 100, psa8: 150, psa9: 200, psa10: 300 }),
      {
        minFlipRawValue: 5,
        minFlipLiquidity: "LOW",
        minFlipConfidence: 0.4,
        minGradeRawValue: 5,
        minGradeConfidence: 0.4,
        maxAcceptableBreakEvenGradeForEligibility: 8,
      },
    );
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBeTruthy();
  });

  it("uses the corrected PSA Regular fee of £65 by default when computing the reference basis", () => {
    expect(DEFAULT_FEE_SCHEDULE.gradingFeePsaRegular).toBe(65);
    const result = computeGradeProfile(snapshot());
    // referenceGradedBasis must be at least rawMarketPrice + the £65 fee alone.
    expect(result.referenceGradedBasis!).toBeGreaterThanOrEqual(200 + 65);
  });
});
