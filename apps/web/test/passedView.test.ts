import { describe, it, expect } from "vitest";
import { buildServerFilterParams, CATEGORY_STATES, DEFAULT_DASHBOARD_FILTERS } from "../src/state/filters";
import type { DashboardFilters } from "../src/state/filters";
import { FEED_HIDDEN_REVIEW_STATUSES } from "../src/state/pipelineStages";

const filters = (over: Partial<DashboardFilters>): DashboardFilters => ({
  ...DEFAULT_DASHBOARD_FILTERS,
  strategy: "GRADE",
  ...over,
});

/**
 * THE HOLE THIS CLOSES, measured on the live database 2026-09-18.
 *
 * Of the 141 active listings under £30 that break even at a PSA 6 — exactly
 * the trade being hunted — 138 were PASSED and 3 were unreviewed. The feed
 * said "no opportunities match the current filters" while holding 141
 * matches, and there was no view anywhere that could show them.
 *
 * Two of my own changes made that: removing the "My decision" filter on the
 * 13th took away the only way to SEE a passed card, and hiding every
 * acted-on status on the 14th took away the only way to STUMBLE on one. Each
 * was right on its own. Together they made Pass a one-way door.
 */
describe("the Passed view", () => {
  it("asks for passed rows instead of hiding them", () => {
    const params = buildServerFilterParams(filters({ category: "PASSED" }));
    expect(params.reviewStatus).toBe("PASS");
  });

  /**
   * Both at once returns nothing — which is the silent empty feed this view
   * exists to end, reproduced inside the view meant to fix it.
   */
  it("never hides and shows the same rows in one request", () => {
    const params = buildServerFilterParams(filters({ category: "PASSED" }));
    expect(params.excludeReviewStatus).toBeUndefined();
  });

  it("leaves every other view hiding them, exactly as before", () => {
    for (const category of ["ACTIONABLE", "REVIEW", "NEAR_MISS", "REJECTED", "ALL"] as const) {
      const params = buildServerFilterParams(filters({ category }));
      expect(params.excludeReviewStatus).toBe(FEED_HIDDEN_REVIEW_STATUSES.join(","));
      expect(params.reviewStatus).toBeUndefined();
    }
  });

  /**
   * No state filter. A pass is a decision about a LISTING and can sit on a
   * row in any state; filtering by state as well would hide passed rows that
   * happen to be in review, which is the same class of mistake again.
   */
  it("does not also filter by state", () => {
    expect(CATEGORY_STATES.PASSED).toBeNull();
  });

  /**
   * The view is "passed cards that match what I am hunting NOW", not every
   * card ever dismissed — otherwise it is unusable at 138 rows and rising.
   */
  it("still applies the economics filters", () => {
    const params = buildServerFilterParams(filters({ category: "PASSED", maxRawAcquisitionCost: 30 }));
    expect(params.maxDeliveredCost).toBe(30);
  });

  it("carries the buy-grade rule in, so you can re-run today's brief over them", () => {
    const params = buildServerFilterParams(
      filters({ category: "PASSED", buyGrade: 6, minBuyGradeProfit: 0 }),
    );
    expect(params.buyGrade).toBe(6);
    expect(params.minBuyGradeProfit).toBe(0);
  });
});
