import { describe, it, expect } from "vitest";
import { summarizeForecastVariance } from "../src/index.js";
import type { ForecastVsRealised } from "../src/index.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream N (AI
 * financial auditor + realised-vs-predicted reconciliation). Pins down
 * `summarizeForecastVariance`'s own arithmetic — the ONE deterministic
 * source of the aggregate statistics the AI financial auditor is allowed to
 * narrate over. In particular: records with no forecast are excluded from
 * `sampleSize` entirely (never counted as a fabricated zero-variance
 * trade), an empty input never divides by zero, and mean/median are
 * genuinely correct against hand-computed expectations.
 */

function record(overrides: Partial<ForecastVsRealised> = {}): ForecastVsRealised {
  return {
    forecastNetProfit: 50,
    realNetProfit: 60,
    profitVariance: 10,
    forecastReturnOnCapital: 0.4,
    realReturnOnCapital: 0.45,
    rocVariance: 0.05,
    forecastCapitalLockDays: 20,
    actualCapitalLockDays: 25,
    capitalLockVariance: 5,
    outperformed: true,
    ...overrides,
  };
}

describe("summarizeForecastVariance", () => {
  it("returns an all-null/zero summary for an empty input, never dividing by zero", () => {
    const summary = summarizeForecastVariance([]);
    expect(summary).toEqual({
      sampleSize: 0,
      outperformedCount: 0,
      underperformedCount: 0,
      outperformedRate: null,
      meanProfitVariance: null,
      medianProfitVariance: null,
      meanRocVariance: null,
      meanCapitalLockVarianceDays: null,
    });
  });

  it("excludes records with no forecast (profitVariance null) from sampleSize entirely", () => {
    const summary = summarizeForecastVariance([
      record({ profitVariance: 10, outperformed: true }),
      record({
        forecastNetProfit: null,
        profitVariance: null,
        forecastReturnOnCapital: null,
        rocVariance: null,
        forecastCapitalLockDays: null,
        capitalLockVariance: null,
        outperformed: null,
      }),
    ]);

    expect(summary.sampleSize).toBe(1);
    expect(summary.meanProfitVariance).toBe(10);
  });

  it("computes a correct mean and median profit variance", () => {
    const summary = summarizeForecastVariance([
      record({ profitVariance: 10 }),
      record({ profitVariance: 20 }),
      record({ profitVariance: -6 }),
    ]);

    expect(summary.sampleSize).toBe(3);
    expect(summary.meanProfitVariance).toBeCloseTo((10 + 20 - 6) / 3, 2);
    expect(summary.medianProfitVariance).toBe(10);
  });

  it("computes the correct median for an even-sized sample (average of the two middle values)", () => {
    const summary = summarizeForecastVariance([
      record({ profitVariance: 10 }),
      record({ profitVariance: 20 }),
      record({ profitVariance: 30 }),
      record({ profitVariance: 40 }),
    ]);

    expect(summary.medianProfitVariance).toBe(25);
  });

  it("counts outperformed vs underperformed correctly and derives outperformedRate as a fraction", () => {
    const summary = summarizeForecastVariance([
      record({ outperformed: true }),
      record({ outperformed: true }),
      record({ outperformed: false }),
      record({ outperformed: false }),
    ]);

    expect(summary.outperformedCount).toBe(2);
    expect(summary.underperformedCount).toBe(2);
    expect(summary.outperformedRate).toBe(0.5);
  });

  it("computes meanRocVariance only from records that actually have one, independent of sampleSize", () => {
    const summary = summarizeForecastVariance([
      record({ rocVariance: 0.1 }),
      record({ rocVariance: 0.3 }),
      record({ rocVariance: null }), // still counted in sampleSize (has a profitVariance), but not in the ROC mean
    ]);

    expect(summary.sampleSize).toBe(3);
    expect(summary.meanRocVariance).toBeCloseTo(0.2, 4);
  });

  it("returns null meanRocVariance when no record in the sample has a comparable ROC figure", () => {
    const summary = summarizeForecastVariance([record({ rocVariance: null }), record({ rocVariance: null })]);
    expect(summary.meanRocVariance).toBeNull();
  });

  it("computes meanCapitalLockVarianceDays only from records that have one", () => {
    const summary = summarizeForecastVariance([
      record({ capitalLockVariance: 4 }),
      record({ capitalLockVariance: 8 }),
      record({ capitalLockVariance: null }),
    ]);

    expect(summary.sampleSize).toBe(3);
    expect(summary.meanCapitalLockVarianceDays).toBe(6);
  });

  it("a single-record sample never crashes and reports sampleSize 1", () => {
    const summary = summarizeForecastVariance([record({ profitVariance: 15 })]);
    expect(summary.sampleSize).toBe(1);
    expect(summary.meanProfitVariance).toBe(15);
    expect(summary.medianProfitVariance).toBe(15);
  });
});
