import { describe, it, expect } from "vitest";
import {
  computeRealisedEconomics,
  allocateBatchCost,
  compareForecastVsRealised,
  computeSellingFees,
} from "../src/index.js";

describe("realised economics", () => {
  it("computes real net profit from actual costs, not forecast ones", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 3 },
      sale: { itemPrice: 220, outboundPostage: 1.55, packaging: 0.75 },
    });

    expect(realised.acquisitionCost).toBeCloseTo(103, 2);
    expect(realised.buyerPayment).toBeCloseTo(220, 2);
    expect(realised.realNetProfit).toBeCloseTo(
      220 - realised.sellingFees - 2.3 - 103,
      2,
    );
  });

  it("uses ACTUAL marketplace fees when a payout statement provides them", () => {
    const withActual = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 0 },
      sale: { itemPrice: 200, outboundPostage: 1.55, packaging: 0.75, actualSellingFees: 31.4 },
    });

    expect(withActual.sellingFees).toBe(31.4);
    expect(withActual.feesWereEstimated).toBe(false);
  });

  it("flags when fees had to be estimated rather than taken from actuals", () => {
    const estimated = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 0 },
      sale: { itemPrice: 200, outboundPostage: 1.55, packaging: 0.75 },
    });

    expect(estimated.feesWereEstimated).toBe(true);
    expect(estimated.sellingFees).toBeCloseTo(computeSellingFees({ itemPrice: 200 }).totalSellingFees, 2);
  });

  it("includes actual grading cost, batch allocation and any upcharge", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 3 },
      grading: { gradingFee: 65, allocatedBatchCost: 7.83, upcharge: 25, consumables: 0.3 },
      sale: { itemPrice: 600, outboundPostage: 4.5, packaging: 0.75, insurance: 2.5 },
    });

    expect(realised.gradingCost).toBeCloseTo(98.13, 2);
    expect(realised.totalCost).toBeCloseTo(201.13, 2);
  });

  it("computes days locked and profit per day", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 0 },
      sale: { itemPrice: 300, outboundPostage: 1.55, packaging: 0.75 },
      purchasedAt: "2026-01-01T00:00:00Z",
      soldAt: "2026-03-02T00:00:00Z",
    });

    expect(realised.daysCapitalLocked).toBe(60);
    expect(realised.profitPerDay).toBeCloseTo(realised.realNetProfit / 60, 2);
  });

  it("leaves capital-lock metrics null when dates are unknown", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 0 },
      sale: { itemPrice: 300, outboundPostage: 1.55, packaging: 0.75 },
    });

    expect(realised.daysCapitalLocked).toBeNull();
    expect(realised.profitPerDay).toBeNull();
  });

  it("reports a real loss honestly", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 300, sellerPostage: 5 },
      sale: { itemPrice: 200, outboundPostage: 1.55, packaging: 0.75 },
    });

    expect(realised.realNetProfit).toBeLessThan(0);
    expect(realised.realReturnOnCapital).toBeLessThan(0);
  });
});

describe("actual grading batch allocation", () => {
  it("divides the REAL batch cost across the cards actually submitted", () => {
    const perCard = allocateBatchCost({
      outboundPostage: 18,
      returnPostage: 22,
      insurance: 14,
      cardCount: 10,
    });
    expect(perCard).toBeCloseTo(5.4, 2);
  });

  it("charges more per card when a batch went out smaller than assumed", () => {
    const assumed = allocateBatchCost({ outboundPostage: 15, returnPostage: 20, insurance: 12, cardCount: 10 });
    const actual = allocateBatchCost({ outboundPostage: 15, returnPostage: 20, insurance: 12, cardCount: 6 });

    expect(actual).toBeGreaterThan(assumed);
    expect(actual).toBeCloseTo(7.83, 2);
  });

  it("rejects an empty batch rather than dividing by zero", () => {
    expect(() =>
      allocateBatchCost({ outboundPostage: 10, returnPostage: 10, insurance: 5, cardCount: 0 }),
    ).toThrow();
  });
});

describe("forecast vs realised", () => {
  it("reports variance against the FROZEN forecast, not a recomputed one", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 3 },
      sale: { itemPrice: 220, outboundPostage: 1.55, packaging: 0.75 },
      purchasedAt: "2026-01-01T00:00:00Z",
      soldAt: "2026-01-21T00:00:00Z",
    });

    const comparison = compareForecastVsRealised({
      forecastNetProfit: 67.22,
      forecastReturnOnCapital: 0.6526,
      forecastCapitalLockDays: 30,
      realised,
    });

    expect(comparison.forecastNetProfit).toBe(67.22); // untouched
    expect(comparison.profitVariance).toBeCloseTo(realised.realNetProfit - 67.22, 2);
    expect(comparison.actualCapitalLockDays).toBe(20);
    expect(comparison.capitalLockVariance).toBe(-10); // sold faster than forecast
  });

  it("marks a trade that beat its forecast as outperforming", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 0 },
      sale: { itemPrice: 400, outboundPostage: 1.55, packaging: 0.75 },
    });

    const comparison = compareForecastVsRealised({
      forecastNetProfit: 50,
      forecastReturnOnCapital: 0.5,
      forecastCapitalLockDays: 30,
      realised,
    });

    expect(comparison.outperformed).toBe(true);
    expect(comparison.profitVariance!).toBeGreaterThan(0);
  });

  it("marks a trade that missed its forecast", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 200, sellerPostage: 0 },
      sale: { itemPrice: 210, outboundPostage: 1.55, packaging: 0.75 },
    });

    const comparison = compareForecastVsRealised({
      forecastNetProfit: 80,
      forecastReturnOnCapital: 0.4,
      forecastCapitalLockDays: 30,
      realised,
    });

    expect(comparison.outperformed).toBe(false);
    expect(comparison.rocVariance!).toBeLessThan(0);
  });

  it("handles a missing forecast without inventing one", () => {
    const realised = computeRealisedEconomics({
      acquisition: { purchasePrice: 100, sellerPostage: 0 },
      sale: { itemPrice: 200, outboundPostage: 1.55, packaging: 0.75 },
    });

    const comparison = compareForecastVsRealised({
      forecastNetProfit: null,
      forecastReturnOnCapital: null,
      forecastCapitalLockDays: null,
      realised,
    });

    expect(comparison.profitVariance).toBeNull();
    expect(comparison.outperformed).toBeNull();
  });
});
