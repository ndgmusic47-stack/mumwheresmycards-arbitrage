import { describe, it, expect } from "vitest";
import {
  compareGradingServices,
  DEFAULT_CLASSIFICATION_SETTINGS,
  DEFAULT_EXIT_MARKET_FEE_MODEL,
  DEFAULT_GRADING_BATCH,
  DEFAULT_GRADING_CONSUMABLES,
  DEFAULT_GRADING_SERVICES,
  DEFAULT_SELLING_COSTS,
  type ServiceComparisonInput,
} from "../src/index.js";

function input(overrides: Partial<ServiceComparisonInput> = {}): ServiceComparisonInput {
  return {
    rawPurchasePrice: 120,
    sellerPostage: 3,
    slabValues: { 7: 150, 8: 260, 9: 500, 10: 1800 },
    slabLiquidity: "MEDIUM",
    services: DEFAULT_GRADING_SERVICES,
    batch: DEFAULT_GRADING_BATCH,
    consumables: DEFAULT_GRADING_CONSUMABLES,
    feeModel: DEFAULT_EXIT_MARKET_FEE_MODEL,
    sellingCosts: DEFAULT_SELLING_COSTS,
    classificationSettings: DEFAULT_CLASSIFICATION_SETTINGS,
    usdPerGbp: 1 / 0.79,
    ...overrides,
  };
}

describe("profit vs capital velocity", () => {
  it("evaluates every enabled service, not just one", () => {
    const result = compareGradingServices(input());
    expect(result.evaluations.map((e) => e.service.id).sort()).toEqual(["PSA_REGULAR", "PSA_VALUE"]);
  });

  it("skips disabled services entirely", () => {
    const result = compareGradingServices(
      input({
        services: DEFAULT_GRADING_SERVICES.map((s) =>
          s.id === "PSA_VALUE" ? { ...s, enabled: false } : s,
        ),
      }),
    );
    expect(result.evaluations.map((e) => e.service.id)).toEqual(["PSA_REGULAR"]);
  });

  it("gives the cheaper service the higher absolute profit", () => {
    const result = compareGradingServices(input());
    const regular = result.evaluations.find((e) => e.service.id === "PSA_REGULAR")!;
    const value = result.evaluations.find((e) => e.service.id === "PSA_VALUE")!;

    // PSA Value costs £42 less per card, so it nets £42 more at every grade.
    expect(value.referenceProfit!).toBeGreaterThan(regular.referenceProfit!);
    expect(result.bestAbsoluteProfit!.service.id).toBe("PSA_VALUE");
  });

  it("computes capital lock as grading turnaround PLUS time to sell", () => {
    const result = compareGradingServices(input({ slabLiquidity: "MEDIUM" }));
    const regular = result.evaluations.find((e) => e.service.id === "PSA_REGULAR")!;

    // 75 business days ≈ 105 calendar days, plus 30 days to sell at MEDIUM.
    expect(regular.estimatedGradingDays).toBe(105);
    expect(regular.estimatedCapitalLockDays).toBe(135);
  });

  it("locks capital far longer on the cheap service", () => {
    const result = compareGradingServices(input());
    const regular = result.evaluations.find((e) => e.service.id === "PSA_REGULAR")!;
    const value = result.evaluations.find((e) => e.service.id === "PSA_VALUE")!;

    expect(value.estimatedCapitalLockDays).toBeGreaterThan(regular.estimatedCapitalLockDays);
  });

  it("computes profit per day of capital lock and an annualised ROC indicator", () => {
    const result = compareGradingServices(input());
    const regular = result.evaluations.find((e) => e.service.id === "PSA_REGULAR")!;

    expect(regular.profitPerCapitalLockDay).toBeCloseTo(
      regular.referenceProfit! / regular.estimatedCapitalLockDays,
      2,
    );
    expect(regular.annualisedRocIndicator).toBeCloseTo(
      regular.referenceRoc! * (365 / regular.estimatedCapitalLockDays),
      3,
    );
  });

  it("shows that the cheapest service is NOT automatically the best on velocity", () => {
    // The whole point: a modest profit returned in 4 months can beat a
    // bigger one returned in 9.
    const result = compareGradingServices(
      input({
        // Values chosen so PSA Regular's faster turnaround wins per-day.
        slabValues: { 7: 150, 8: 260, 9: 520, 10: 1800 },
      }),
    );

    expect(result.bestAbsoluteProfit!.service.id).toBe("PSA_VALUE");
    expect(result.bestCapitalVelocity!.service.id).toBe("PSA_REGULAR");
    expect(result.bestProfitAndVelocityDiffer).toBe(true);
  });

  it("flags a potential upcharge when a slab value breaches the service cap", () => {
    // £1,000 ≈ $1,266 — over PSA Value's $500 cap, under PSA Regular's $1,500.
    const result = compareGradingServices(input({ slabValues: { 9: 300, 10: 1000 } }));

    const value = result.evaluations.find((e) => e.service.id === "PSA_VALUE")!;
    const regular = result.evaluations.find((e) => e.service.id === "PSA_REGULAR")!;

    expect(value.anyPotentialUpcharge).toBe(true); // $500 cap breached
    expect(regular.anyPotentialUpcharge).toBe(false); // $1500 cap not breached
  });

  it("flags an upcharge on BOTH services once the value clears the higher cap too", () => {
    // £1,200 ≈ $1,519 — over PSA Regular's $1,500 cap as well.
    const result = compareGradingServices(input({ slabValues: { 9: 300, 10: 1200 } }));
    expect(result.evaluations.every((e) => e.anyPotentialUpcharge)).toBe(true);
  });

  it("classifies and computes required hit rates per service", () => {
    const result = compareGradingServices(input());

    for (const evaluation of result.evaluations) {
      expect(evaluation.classification.economicClass).toBeDefined();
      expect(evaluation.requiredPsa10RateVsPsa9).toBeDefined();
      expect(evaluation.requiredPsa10RateVsPsa8).toBeDefined();
    }
  });

  it("can flip an economic class between services", () => {
    // A card that only breaks even at PSA 7 on the cheaper service.
    const result = compareGradingServices(
      input({ rawPurchasePrice: 60, slabValues: { 7: 115, 8: 200, 9: 400, 10: 1500 } }),
    );

    const regular = result.evaluations.find((e) => e.service.id === "PSA_REGULAR")!;
    const value = result.evaluations.find((e) => e.service.id === "PSA_VALUE")!;

    expect(regular.classification.economicClass).not.toBe("DOWNSIDE_PROTECTED");
    expect(value.classification.economicClass).toBe("DOWNSIDE_PROTECTED");
  });

  it("returns no winners when nothing is evaluable", () => {
    const result = compareGradingServices(input({ services: [] }));
    expect(result.evaluations).toHaveLength(0);
    expect(result.bestAbsoluteProfit).toBeNull();
    expect(result.bestCapitalVelocity).toBeNull();
  });
});
