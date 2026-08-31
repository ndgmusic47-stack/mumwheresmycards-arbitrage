import { describe, it, expect } from "vitest";
import {
  qualifyFlip,
  qualifyGrade,
  computeAcquisitionCost,
  computeNetSaleProceeds,
  computeFlipProfit,
  DEFAULT_FLIP_QUALIFICATION,
  DEFAULT_GRADE_QUALIFICATION,
  type FlipQualificationInput,
  type GradeQualificationInput,
} from "../src/index.js";

const passingFlip: FlipQualificationInput = {
  netProfit: 60,
  returnOnCapital: 0.55,
  totalAcquisitionCost: 110,
  qsv: 200,
  liquidity: "HIGH",
  confidence: 0.8,
  expectedDaysToSale: 14,
  isHighConfidenceQsv: true,
};

describe("raw flip qualification — £40 AND 40%, both required", () => {
  it("defaults to £40 net profit and 40% ROC", () => {
    expect(DEFAULT_FLIP_QUALIFICATION.minNetProfit).toBe(40);
    expect(DEFAULT_FLIP_QUALIFICATION.minReturnOnCapital).toBe(0.4);
  });

  it("qualifies a trade that clears both bars", () => {
    const result = qualifyFlip(passingFlip, DEFAULT_FLIP_QUALIFICATION);
    expect(result.qualifies).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("REJECTS a small flip whose ROC looks great but whose profit is trivial", () => {
    // £12 profit on a £15 card = 80% ROC. Percentage alone must not qualify it.
    const result = qualifyFlip(
      { ...passingFlip, netProfit: 12, returnOnCapital: 0.8, totalAcquisitionCost: 15, qsv: 30 },
      DEFAULT_FLIP_QUALIFICATION,
    );

    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("minNetProfit");
  });

  it("REJECTS a big-ticket trade with real profit but poor ROC", () => {
    // £45 on £900 deployed = 5% ROC. Absolute profit alone must not qualify it.
    const result = qualifyFlip(
      { ...passingFlip, netProfit: 45, returnOnCapital: 0.05, totalAcquisitionCost: 900 },
      DEFAULT_FLIP_QUALIFICATION,
    );

    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("minReturnOnCapital");
  });

  it("rejects a QSV built on a fallback reference rather than sold medians", () => {
    const result = qualifyFlip({ ...passingFlip, isHighConfidenceQsv: false }, DEFAULT_FLIP_QUALIFICATION);

    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("qsvBasis");
  });

  it("enforces liquidity, confidence, acquisition cap and days-to-sale", () => {
    expect(qualifyFlip({ ...passingFlip, liquidity: "LOW" }, DEFAULT_FLIP_QUALIFICATION).qualifies).toBe(false);
    expect(qualifyFlip({ ...passingFlip, confidence: 0.2 }, DEFAULT_FLIP_QUALIFICATION).qualifies).toBe(false);
    expect(
      qualifyFlip({ ...passingFlip, totalAcquisitionCost: 5000 }, DEFAULT_FLIP_QUALIFICATION).qualifies,
    ).toBe(false);
    expect(qualifyFlip({ ...passingFlip, expectedDaysToSale: 120 }, DEFAULT_FLIP_QUALIFICATION).qualifies).toBe(
      false,
    );
  });

  it("reports EVERY failing rule, not just the first", () => {
    const result = qualifyFlip(
      { ...passingFlip, netProfit: 1, returnOnCapital: 0.01, liquidity: "LOW", confidence: 0.1 },
      DEFAULT_FLIP_QUALIFICATION,
    );
    expect(result.failures.length).toBeGreaterThanOrEqual(4);
  });

  it("is fully editable — a stricter rule set changes the outcome with no code change", () => {
    const stricter = { ...DEFAULT_FLIP_QUALIFICATION, minNetProfit: 500 };
    expect(qualifyFlip(passingFlip, stricter).qualifies).toBe(false);
  });

  it("qualifies end-to-end from real fee arithmetic", () => {
    const acquisition = computeAcquisitionCost({ purchasePrice: 100, sellerPostage: 3 });
    const sale = computeNetSaleProceeds({ itemPrice: 200 });
    const profit = computeFlipProfit({
      totalAcquisitionCost: acquisition.total,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
      expectedDaysToSale: 14,
    });

    const result = qualifyFlip(
      {
        netProfit: profit.netProfit,
        returnOnCapital: profit.returnOnCapital,
        totalAcquisitionCost: acquisition.total,
        qsv: 200,
        liquidity: "HIGH",
        confidence: 0.8,
        expectedDaysToSale: 14,
        isHighConfidenceQsv: true,
      },
      DEFAULT_FLIP_QUALIFICATION,
    );

    expect(profit.netProfit).toBeGreaterThan(40);
    expect(profit.returnOnCapital).toBeGreaterThan(0.4);
    expect(result.qualifies).toBe(true);
  });
});

const passingGrade: GradeQualificationInput = {
  economicClass: "DOWNSIDE_PROTECTED",
  rawAcquisitionCost: 120,
  totalGradedBasis: 200,
  psa10Value: 2000,
  psa10Profit: 1500,
  psa10GrossMultiple: 10,
  psa9Profit: 200,
  psa8Profit: 40,
  breakEvenGrade: 7,
  requiredPsa10RateVsPsa9: 0,
  liquidity: "MEDIUM",
  confidence: 0.7,
  estimatedCapitalLockDays: 135,
  graderId: "PSA",
  serviceId: "PSA_REGULAR",
};

describe("grade qualification — structure first", () => {
  it("qualifies all three economic structures by default", () => {
    expect(DEFAULT_GRADE_QUALIFICATION.enabledEconomicClasses).toEqual([
      "DOWNSIDE_PROTECTED",
      "BALANCED",
      "ASYMMETRIC",
    ]);

    for (const economicClass of ["DOWNSIDE_PROTECTED", "BALANCED", "ASYMMETRIC"] as const) {
      const result = qualifyGrade({ ...passingGrade, economicClass }, DEFAULT_GRADE_QUALIFICATION);
      expect(result.qualifies).toBe(true);
    }
  });

  it("rejects an unclassified card", () => {
    const result = qualifyGrade({ ...passingGrade, economicClass: "UNCLASSIFIED" }, DEFAULT_GRADE_QUALIFICATION);
    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("economicClass");
  });

  it("does NOT reject an asymmetric card for losing at PSA 8 by default", () => {
    const result = qualifyGrade(
      { ...passingGrade, economicClass: "ASYMMETRIC", psa8Profit: -150, psa9Profit: -40, breakEvenGrade: 10 },
      DEFAULT_GRADE_QUALIFICATION,
    );
    expect(result.qualifies).toBe(true);
  });

  it("only allows enabled graders — a cheap disabled grader cannot sneak in", () => {
    const result = qualifyGrade({ ...passingGrade, graderId: "TAG" }, DEFAULT_GRADE_QUALIFICATION);
    expect(result.qualifies).toBe(false);
    expect(result.failures.map((f) => f.rule)).toContain("grader");
  });

  it("enforces a required-hit-rate ceiling once one is configured", () => {
    const rules = { ...DEFAULT_GRADE_QUALIFICATION, maxRequiredPsa10Rate: 0.1 };

    expect(qualifyGrade({ ...passingGrade, requiredPsa10RateVsPsa9: 0.05 }, rules).qualifies).toBe(true);
    expect(qualifyGrade({ ...passingGrade, requiredPsa10RateVsPsa9: 0.4 }, rules).qualifies).toBe(false);
  });

  it("enforces a capital-lock ceiling once one is configured", () => {
    const rules = { ...DEFAULT_GRADE_QUALIFICATION, maxEstimatedCapitalLockDays: 120 };
    expect(qualifyGrade({ ...passingGrade, estimatedCapitalLockDays: 250 }, rules).qualifies).toBe(false);
  });

  it("applies the PSA8 loss floor only when configured to", () => {
    const lenient = qualifyGrade({ ...passingGrade, psa8Profit: -500 }, DEFAULT_GRADE_QUALIFICATION);
    const strict = qualifyGrade(
      { ...passingGrade, psa8Profit: -500 },
      { ...DEFAULT_GRADE_QUALIFICATION, maxPsa8LossPctOfBasis: 0.1 },
    );

    expect(lenient.qualifies).toBe(true);
    expect(strict.qualifies).toBe(false);
  });

  it("applies a break-even ceiling only when configured to", () => {
    const noCeiling = qualifyGrade({ ...passingGrade, breakEvenGrade: null }, DEFAULT_GRADE_QUALIFICATION);
    const withCeiling = qualifyGrade(
      { ...passingGrade, breakEvenGrade: null },
      { ...DEFAULT_GRADE_QUALIFICATION, maxBreakEvenGrade: 9 },
    );

    expect(noCeiling.qualifies).toBe(true);
    expect(withCeiling.qualifies).toBe(false);
  });
});
