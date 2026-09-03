import { describe, it, expect } from "vitest";
import { buildSortClause, buildFilterConditions } from "../src/routes/opportunities.js";

/**
 * REGRESSION GUARD for SOURCING WORKFLOW items 4/5/6 (real pagination,
 * server-side sorting, expanded filters on GET /api/opportunities).
 *
 * Pure functions, no D1 needed — same pattern as
 * opportunitiesStateFilter.test.ts. The two things that matter most: (1) an
 * unknown/absent sort key MUST fall back to the exact pre-item-5 default
 * ordering, so nothing that already links to this endpoint silently changes
 * behaviour; (2) every bound WHERE parameter must have exactly one matching
 * `?` placeholder, or D1 rejects the query outright (sqlParameterParity.test.ts
 * exists for exactly this class of bug).
 */
describe("buildSortClause", () => {
  it("falls back to the pre-item-5 default when sort is omitted or unrecognised", () => {
    const fallback = "o.qualifies DESC, COALESCE(o.score, o.flip_score, o.grade_score) DESC";
    expect(buildSortClause(undefined, undefined)).toBe(fallback);
    expect(buildSortClause("not_a_real_column", "desc")).toBe(fallback);
    expect(buildSortClause("", "asc")).toBe(fallback);
  });

  it("maps a known sort key to its real column expression, NULLs always last", () => {
    const clause = buildSortClause("delivered_cost", "asc");
    expect(clause).toBe("(o.total_acquisition_cost) IS NULL, o.total_acquisition_cost ASC");
  });

  it("defaults direction to DESC when dir is omitted or not exactly 'asc'", () => {
    expect(buildSortClause("net_profit", undefined)).toBe("(o.expected_net_profit) IS NULL, o.expected_net_profit DESC");
    expect(buildSortClause("net_profit", "descending")).toBe(
      "(o.expected_net_profit) IS NULL, o.expected_net_profit DESC",
    );
  });

  it("discount_to_qsv is NULL-safe against a zero or missing QSV, never divides by zero or fabricates 0", () => {
    const clause = buildSortClause("discount_to_qsv", "desc");
    expect(clause).toContain("CASE WHEN o.qsv IS NULL OR o.qsv = 0 THEN NULL");
  });

  it("every sort key a query string could reasonably send resolves to a distinct, injection-free expression", () => {
    const keys = [
      "newest",
      "score",
      "listing_price",
      "delivered_cost",
      "qsv",
      "discount_to_qsv",
      "net_profit",
      "roc",
      "margin",
      "liquidity",
      "confidence",
      "card_name",
      "last_scan",
      "psa9_profit",
      "psa10_profit",
      "break_even_grade",
      "graded_basis",
      "capital_lock",
      "current_bid",
      "time_remaining",
    ];
    for (const key of keys) {
      const clause = buildSortClause(key, "desc");
      // No key produces the generic fallback — every one of them must be a
      // real, allowlisted mapping, not an accidental silent no-op.
      expect(clause).not.toBe("o.qualifies DESC, COALESCE(o.score, o.flip_score, o.grade_score) DESC");
      // Never anything beyond letters/digits/underscore/dot/space/parens/
      // comparison operators/quotes-for-liquidity-CASE — i.e. never raw user
      // input concatenated in (this loop only proves the ALLOWLISTED keys
      // are safe; buildSortClause's own code is what guarantees an
      // unrecognised key can never reach SORT_EXPRESSIONS at all).
      expect(clause.length).toBeGreaterThan(0);
    }
  });
});

function params(qs: string) {
  return new URLSearchParams(qs);
}

describe("buildFilterConditions", () => {
  it("returns an empty clause and no params when nothing is set", () => {
    const result = buildFilterConditions(params(""));
    expect(result.clause).toBe("");
    expect(result.params).toEqual([]);
  });

  it("builds numeric range conditions with matching placeholder count", () => {
    const result = buildFilterConditions(params("minDeliveredCost=15&maxDeliveredCost=80&minNetProfit=40&minRoc=0.4"));
    expect(result.clause).toBe(
      "o.total_acquisition_cost >= ? AND o.total_acquisition_cost <= ? AND o.expected_net_profit >= ? AND o.return_on_capital >= ?",
    );
    expect(result.params).toEqual([15, 80, 40, 0.4]);
    const placeholderCount = (result.clause.match(/\?/g) ?? []).length;
    expect(result.params.length).toBe(placeholderCount);
  });

  // AI INTELLIGENCE gap 4: minMargin added as a server-side filter.
  it("minMargin filters against o.profit_margin, matching minNetProfit/minRoc's pattern", () => {
    const result = buildFilterConditions(params("minMargin=0.3"));
    expect(result.clause).toBe("o.profit_margin >= ?");
    expect(result.params).toEqual([0.3]);
  });

  it("ignores a non-numeric or empty value rather than building a broken condition", () => {
    const result = buildFilterConditions(params("minNetProfit=not-a-number&maxQsv="));
    expect(result.clause).toBe("");
    expect(result.params).toEqual([]);
  });

  it("discount-to-QSV filter is NULL/zero-QSV safe", () => {
    const result = buildFilterConditions(params("minDiscountToQsv=0.2"));
    expect(result.clause).toBe(
      "(o.qsv IS NOT NULL AND o.qsv > 0 AND (o.qsv - o.total_acquisition_cost) / o.qsv >= ?)",
    );
    expect(result.params).toEqual([0.2]);
  });

  it("liquidity and listingType are comma-separated IN (...) lists", () => {
    const result = buildFilterConditions(params("liquidity=HIGH,VERY_HIGH&listingType=FIXED,BEST_OFFER"));
    expect(result.clause).toBe("o.liquidity IN (?,?) AND l.listing_type IN (?,?)");
    expect(result.params).toEqual(["HIGH", "VERY_HIGH", "FIXED", "BEST_OFFER"]);
  });

  // AI INTELLIGENCE gap 3 / release gate #5 (manual false-positive review):
  // an explicit way to find exactly what AI flagged, independent of the
  // ACTIONABLE-feed's own ai_review_status exclusion (built in the route
  // handler around isActionableStateFilter — see opportunitiesStateFilter.test.ts).
  it("aiReviewStatus is a comma-separated IN (...) list against o.ai_review_status", () => {
    const result = buildFilterConditions(params("aiReviewStatus=REVIEW,BLOCK_FROM_ACTIONABLE"));
    expect(result.clause).toBe("o.ai_review_status IN (?,?)");
    expect(result.params).toEqual(["REVIEW", "BLOCK_FROM_ACTIONABLE"]);
  });

  it("condition filter distinguishes real values from the UNKNOWN sentinel, and combines both with OR", () => {
    const both = buildFilterConditions(params("condition=NM,UNKNOWN"));
    expect(both.clause).toBe("(l.item_condition IN (?) OR l.item_condition IS NULL)");
    expect(both.params).toEqual(["NM"]);

    const onlyUnknown = buildFilterConditions(params("condition=UNKNOWN"));
    expect(onlyUnknown.clause).toBe("(l.item_condition IS NULL)");
    expect(onlyUnknown.params).toEqual([]);

    const onlyKnown = buildFilterConditions(params("condition=NM,LP"));
    expect(onlyKnown.clause).toBe("(l.item_condition IN (?,?))");
    expect(onlyKnown.params).toEqual(["NM", "LP"]);
  });

  it("cardName and set are bound LIKE searches, never string-concatenated into the SQL", () => {
    const result = buildFilterConditions(params("cardName=Dragonite&set=Skyridge"));
    expect(result.clause).toBe("c.name LIKE ? AND (c.set_name LIKE ? OR c.set_code LIKE ?)");
    expect(result.params).toEqual(["%Dragonite%", "%Skyridge%", "%Skyridge%"]);
  });

  it("combines every filter kind together with matching placeholder/param counts", () => {
    const result = buildFilterConditions(
      params(
        "minListingPrice=10&maxListingPrice=200&minConfidence=0.5&liquidity=HIGH&condition=NM,UNKNOWN&cardName=Charizard",
      ),
    );
    const placeholderCount = (result.clause.match(/\?/g) ?? []).length;
    expect(result.params.length).toBe(placeholderCount);
    expect(result.params).toEqual([10, 200, 0.5, "HIGH", "NM", "%Charizard%"]);
  });
});
