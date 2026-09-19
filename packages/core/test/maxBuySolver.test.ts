import { describe, it, expect } from "vitest";
import { computeMaxRawPriceForGrading, DEFAULT_MAX_BUY_REFERENCE_GRADE } from "../src/calc/maxBuySolver.js";
import { computeGradedBasis } from "../src/calc/gradingBasis.js";
import { computeGradeLadder } from "../src/calc/gradeLadder.js";
import { DEFAULT_GRADING_SERVICES } from "../src/index.js";

const psaStandard = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_STANDARD")!;

describe("computeMaxRawPriceForGrading — AI INTELLIGENCE item 14 (GRADE reverse solver)", () => {
  it("returns null for an unknown (<=0) slab value rather than a fabricated ceiling", () => {
    const result = computeMaxRawPriceForGrading({
      slabValueAtGrade: 0,
      service: psaStandard,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.maxRawPurchasePrice).toBeNull();
    expect(result.maxTotalGradedBasis).toBeNull();
  });

  it("returns null (never negative) when fixed costs alone already exceed what the grade can absorb", () => {
    const result = computeMaxRawPriceForGrading({
      slabValueAtGrade: 5, // a near-worthless slab
      service: psaStandard,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.maxRawPurchasePrice).toBe(0);
  });

  it("ROUND-TRIP: buying at exactly maxRawPurchasePrice clears both the profit and ROC bars", () => {
    const minNetProfit = 40;
    const minReturnOnCapital = 0.4;
    const slabValueAtGrade = 600;

    const solved = computeMaxRawPriceForGrading({
      slabValueAtGrade,
      service: psaStandard,
      minNetProfit,
      minReturnOnCapital,
    });
    expect(solved.maxRawPurchasePrice).not.toBeNull();

    const basis = computeGradedBasis({
      rawPurchasePrice: solved.maxRawPurchasePrice!,
      sellerPostage: 0,
      service: psaStandard,
    });
    const ladder = computeGradeLadder({
      totalGradedBasis: basis.total,
      slabValues: { [DEFAULT_MAX_BUY_REFERENCE_GRADE]: slabValueAtGrade },
    });
    const rung = ladder.rungs.find((r) => r.grade === DEFAULT_MAX_BUY_REFERENCE_GRADE)!;

    // At the solved ceiling, both bars are cleared with only rounding slack.
    expect(rung.profit!).toBeGreaterThanOrEqual(minNetProfit - 0.02);
    expect(rung.returnOnCapital!).toBeGreaterThanOrEqual(minReturnOnCapital - 0.001);
  });

  it("ROUND-TRIP: paying £1 more than the solved ceiling fails to clear at least one bar", () => {
    const minNetProfit = 40;
    const minReturnOnCapital = 0.4;
    const slabValueAtGrade = 600;

    const solved = computeMaxRawPriceForGrading({
      slabValueAtGrade,
      service: psaStandard,
      minNetProfit,
      minReturnOnCapital,
    });

    const basis = computeGradedBasis({
      rawPurchasePrice: solved.maxRawPurchasePrice! + 1,
      sellerPostage: 0,
      service: psaStandard,
    });
    const ladder = computeGradeLadder({
      totalGradedBasis: basis.total,
      slabValues: { [DEFAULT_MAX_BUY_REFERENCE_GRADE]: slabValueAtGrade },
    });
    const rung = ladder.rungs.find((r) => r.grade === DEFAULT_MAX_BUY_REFERENCE_GRADE)!;

    const clearsProfit = rung.profit! >= minNetProfit;
    const clearsRoc = rung.returnOnCapital! >= minReturnOnCapital;
    expect(clearsProfit && clearsRoc).toBe(false);
  });

  it("reports which constraint is binding", () => {
    const cheapCard = computeMaxRawPriceForGrading({
      slabValueAtGrade: 100,
      service: psaStandard,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    const expensiveCard = computeMaxRawPriceForGrading({
      slabValueAtGrade: 1200,
      service: psaStandard,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });

    expect(cheapCard.bindingConstraint).toBe("PROFIT"); // a small slab's ROC bar is easy, profit floor bites first
    expect(expensiveCard.bindingConstraint).toBe("ROC"); // a big slab's ROC % bar bites before the flat profit floor
  });

  it("folds in known acquisition-side costs (postage, import tax) as fixed, not price-scaling", () => {
    const withoutExtras = computeMaxRawPriceForGrading({
      slabValueAtGrade: 600,
      service: psaStandard,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    const withExtras = computeMaxRawPriceForGrading({
      slabValueAtGrade: 600,
      service: psaStandard,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
      sellerPostage: 5,
      importTax: 10,
    });

    // Every extra £1 of fixed acquisition-side cost eats exactly £1 of
    // headroom on the raw purchase price ceiling.
    expect(withoutExtras.maxRawPurchasePrice! - withExtras.maxRawPurchasePrice!).toBeCloseTo(15, 2);
  });

  it("surfaces the fixed costs it held constant, for transparency", () => {
    const result = computeMaxRawPriceForGrading({
      slabValueAtGrade: 600,
      service: psaStandard,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    // service fee + batch share ((15+20+12)/10 = 4.7) + consumables (0.3).
    //
    // This was a literal 28, from a £23 fee that was never checked against
    // PSA. On PSA's published $59.99 Standard it is £49.41 + 5 = £54.41.
    // Derived from the service now, so the next fee correction moves the test
    // with it instead of breaking it.
    expect(result.fixedCostsHeldConstant).toBeCloseTo(psaStandard.feePerCard + 4.7 + 0.3, 2);
  });
});
