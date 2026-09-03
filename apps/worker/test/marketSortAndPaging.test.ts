import { describe, it, expect } from "vitest";
import { buildMarketSortClause } from "../src/routes/market.js";

/**
 * REGRESSION GUARD for SOURCING WORKFLOW items 4/5/6 applied to GET /market
 * (the MARKET catalogue page): real page-based pagination and sorting, same
 * allowlisted-expression pattern as GET /api/opportunities.
 */
describe("buildMarketSortClause", () => {
  it("falls back to the pre-existing combined-score default when sort is omitted or unrecognised", () => {
    const fallback = "COALESCE(gp.grade_market_score, 0) + COALESCE(fp.flip_market_score, 0) DESC";
    expect(buildMarketSortClause(undefined, undefined)).toBe(fallback);
    expect(buildMarketSortClause("not_a_real_column", "desc")).toBe(fallback);
  });

  it("maps a known key to its real column, NULLs always last, dir defaults to DESC", () => {
    expect(buildMarketSortClause("psa10", undefined)).toBe("(gp.psa10) IS NULL, gp.psa10 DESC");
    expect(buildMarketSortClause("raw_market_value", "asc")).toBe(
      "(fp.raw_market_value) IS NULL, fp.raw_market_value ASC",
    );
  });
});
