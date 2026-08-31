import { describe, it, expect } from "vitest";
import {
  computeGradeLadder,
  findBreakEvenGrade,
  exceedsDeclaredValueCap,
  DEFAULT_GRADING_SERVICES,
} from "../src/index.js";

const PSA_REGULAR = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_REGULAR")!;
const PSA_VALUE = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_VALUE")!;

describe("computeGradeLadder", () => {
  it("computes gross value, fees, net proceeds, profit and ROC at every grade", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 200,
      slabValues: { 6: 80, 7: 150, 8: 300, 9: 600, 10: 2000 },
    });

    for (const rung of ladder.rungs) {
      expect(rung.grossSlabValue).not.toBeNull();
      expect(rung.sellingFees).not.toBeNull();
      expect(rung.netProceeds).not.toBeNull();
      expect(rung.profit).not.toBeNull();
      expect(rung.returnOnCapital).not.toBeNull();
    }
  });

  it("does NOT hide losing grades", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 500,
      slabValues: { 7: 100, 8: 200, 9: 400, 10: 5000 },
    });

    const psa7 = ladder.rungs.find((r) => r.grade === 7)!;
    const psa8 = ladder.rungs.find((r) => r.grade === 8)!;

    expect(psa7.profit).toBeLessThan(0);
    expect(psa8.profit).toBeLessThan(0);
    // ...and they are still present in the ladder, with real numbers.
    expect(psa7.netProceeds).toBeGreaterThan(0);
  });

  it("leaves grades with no market data as null rather than guessing", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 200,
      slabValues: { 9: 600, 10: 2000 },
    });

    const psa6 = ladder.rungs.find((r) => r.grade === 6)!;
    expect(psa6.grossSlabValue).toBeNull();
    expect(psa6.profit).toBeNull();
  });

  it("identifies the lowest break-even grade", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 200,
      slabValues: { 7: 100, 8: 260, 9: 600, 10: 2000 },
    });
    expect(ladder.breakEvenGrade).toBe(8);
  });

  it("returns a null break-even grade when nothing breaks even", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 5000,
      slabValues: { 7: 100, 8: 200, 9: 400, 10: 900 },
    });
    expect(ladder.breakEvenGrade).toBeNull();
  });

  it("computes the PSA10 gross multiple against the graded basis", () => {
    const ladder = computeGradeLadder({ totalGradedBasis: 200, slabValues: { 10: 2000 } });
    expect(ladder.psa10GrossMultiple).toBeCloseTo(10, 2);
    // Net multiple is lower — fees and postage come out of the gross.
    expect(ladder.psa10NetMultiple!).toBeLessThan(ladder.psa10GrossMultiple!);
  });

  it("deducts real eBay fees from every rung's proceeds", () => {
    const ladder = computeGradeLadder({ totalGradedBasis: 100, slabValues: { 10: 1000 } });
    const psa10 = ladder.rungs.find((r) => r.grade === 10)!;

    expect(psa10.sellingFees).toBeGreaterThan(0);
    expect(psa10.netProceeds!).toBeLessThan(1000);
  });

  it("rejects a non-positive basis", () => {
    expect(() => computeGradeLadder({ totalGradedBasis: 0, slabValues: { 10: 100 } })).toThrow();
  });
});

describe("declared-value cap / potential upcharge", () => {
  const usdPerGbp = 1 / 0.79; // matches DEFAULT_FX_RATES (USD: 0.79 -> $1 = £0.79)

  it("flags a grade whose slab value exceeds the service's final-value limit", () => {
    // PSA Value caps at $500 ≈ £395.
    const ladder = computeGradeLadder({
      totalGradedBasis: 150,
      slabValues: { 9: 300, 10: 1200 },
      service: PSA_VALUE,
      usdPerGbp,
    });

    const psa9 = ladder.rungs.find((r) => r.grade === 9)!;
    const psa10 = ladder.rungs.find((r) => r.grade === 10)!;

    expect(psa9.potentialUpcharge).toBe(false); // £300 ≈ $380, under the cap
    expect(psa10.potentialUpcharge).toBe(true); // £1200 ≈ $1519, over it
    expect(ladder.anyPotentialUpcharge).toBe(true);
  });

  it("does not flag the same card on a higher-cap service", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 150,
      slabValues: { 10: 1000 }, // ≈ $1266, under PSA Regular's $1500
      service: PSA_REGULAR,
      usdPerGbp,
    });
    expect(ladder.anyPotentialUpcharge).toBe(false);
  });

  it("abstains rather than guessing when no FX rate is available", () => {
    expect(exceedsDeclaredValueCap(100_000, 500, null)).toBe(false);
  });

  it("abstains when the service has no declared cap", () => {
    expect(exceedsDeclaredValueCap(100_000, null, 1.27)).toBe(false);
  });
});

describe("findBreakEvenGrade", () => {
  it("returns the lowest profitable grade, ignoring unpopulated ones", () => {
    expect(
      findBreakEvenGrade([
        { grade: 6, grossSlabValue: null, sellingFees: null, netProceeds: null, profit: null, returnOnCapital: null, potentialUpcharge: false },
        { grade: 7, grossSlabValue: 10, sellingFees: 2, netProceeds: 8, profit: -50, returnOnCapital: -0.5, potentialUpcharge: false },
        { grade: 8, grossSlabValue: 200, sellingFees: 30, netProceeds: 170, profit: 20, returnOnCapital: 0.13, potentialUpcharge: false },
        { grade: 9, grossSlabValue: 400, sellingFees: 60, netProceeds: 340, profit: 190, returnOnCapital: 1.2, potentialUpcharge: false },
      ]),
    ).toBe(8);
  });
});
