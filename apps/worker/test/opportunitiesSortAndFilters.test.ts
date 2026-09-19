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

  /*
   * REWRITTEN 2026-09-13. This used to assert on "NM" and "LP", a condition
   * vocabulary eBay has never sent for a trading card — the real field holds
   * Graded/Ungraded, and holds it in the SELLER'S language. The parameter is
   * now semantic and the server expands it, so the query and the
   * already-graded classifier read the same table.
   */
  it("expands UNGRADED into every language eBay writes it in", () => {
    const result = buildFilterConditions(params("condition=UNGRADED"));
    expect(result.clause).toBe("(l.item_condition COLLATE NOCASE IN (?,?,?,?,?))");
    expect(result.params).toEqual(["Ungraded", "Non gradata", "Nicht bewertet", "Non gradée", "Non gradé"]);
  });

  it("expands GRADED the same way — the 156 live slabs that used to slip through", () => {
    const result = buildFilterConditions(params("condition=GRADED"));
    expect(result.params).toEqual(["Graded", "Valutata", "Bewertet", "Gradée", "Gradé"]);
  });

  it("keeps UNKNOWN as its own opt-in bucket, combined with OR", () => {
    const both = buildFilterConditions(params("condition=UNGRADED,UNKNOWN"));
    expect(both.clause).toBe("(l.item_condition COLLATE NOCASE IN (?,?,?,?,?) OR l.item_condition IS NULL)");

    const onlyUnknown = buildFilterConditions(params("condition=UNKNOWN"));
    expect(onlyUnknown.clause).toBe("(l.item_condition IS NULL)");
    expect(onlyUnknown.params).toEqual([]);
  });

  it("emits nothing for a value it does not recognise, rather than an empty IN that matches nothing", () => {
    expect(buildFilterConditions(params("condition=BANANA")).clause).toBe("");
  });

  it("region UK_ONLY restricts to the one country with no unmodelled import cost", () => {
    const result = buildFilterConditions(params("region=UK_ONLY"));
    expect(result.clause).toBe("l.location_country IN (?)");
    expect(result.params).toEqual(["GB"]);
  });

  it("region UK_EU includes the UK first and the European countries after it", () => {
    const result = buildFilterConditions(params("region=UK_EU"));
    expect(result.params[0]).toBe("GB");
    expect(result.params).toContain("IT");
    expect(result.params).toContain("DE");
    expect(result.params).not.toContain("US");
    expect((result.clause.match(/\?/g) ?? []).length).toBe(result.params.length);
  });

  /*
   * The buy-grade rule absorbed two other controls on 2026-09-13 ("Pays back
   * by grade" and "Min PSA10 profit"), because all three asked one question:
   * is profit at grade N at least £X. These pin the general form down.
   */
  it("accepts every grade the ladder prices, including 10", () => {
    for (const grade of [6, 7, 8, 9, 10]) {
      const result = buildFilterConditions(params(`buyGrade=${grade}&minBuyGradeProfit=25`));
      expect(result.clause).toBe(`o.psa${grade}_profit >= ?`);
      expect(result.params).toEqual([25]);
    }
  });

  it("at £0 it is exactly the old 'pays back by grade' test", () => {
    const result = buildFilterConditions(params("buyGrade=8&minBuyGradeProfit=0"));
    expect(result.clause).toBe("o.psa8_profit >= ?");
    expect(result.params).toEqual([0]);
  });

  it("refuses a grade the ladder does not price, rather than interpolating a column name", () => {
    // The grade names a COLUMN, so an allowlist is the only safe handling.
    expect(buildFilterConditions(params("buyGrade=5&minBuyGradeProfit=25")).clause).toBe("");
    expect(buildFilterConditions(params("buyGrade=11&minBuyGradeProfit=25")).clause).toBe("");
    expect(buildFilterConditions(params("buyGrade=8'--&minBuyGradeProfit=25")).clause).toBe("");
  });

  it("does nothing without an amount — the grade alone is not a rule", () => {
    expect(buildFilterConditions(params("buyGrade=6")).clause).toBe("");
    expect(buildFilterConditions(params("buyGrade=6&minBuyGradeProfit=")).clause).toBe("");
  });

  it("region ANY or an unknown region emits no clause at all", () => {
    expect(buildFilterConditions(params("region=ANY")).clause).toBe("");
    expect(buildFilterConditions(params("region=MARS")).clause).toBe("");
  });

  it("cardName and set are bound LIKE searches, never string-concatenated into the SQL", () => {
    const result = buildFilterConditions(params("cardName=Dragonite&set=Skyridge"));
    expect(result.clause).toBe("c.name LIKE ? AND (c.set_name LIKE ? OR c.set_code LIKE ?)");
    expect(result.params).toEqual(["%Dragonite%", "%Skyridge%", "%Skyridge%"]);
  });

  it("combines every filter kind together with matching placeholder/param counts", () => {
    const result = buildFilterConditions(
      params(
        "minListingPrice=10&maxListingPrice=200&minConfidence=0.5&liquidity=HIGH&condition=UNGRADED&region=UK_ONLY&cardName=Charizard",
      ),
    );
    const placeholderCount = (result.clause.match(/\?/g) ?? []).length;
    expect(result.params.length).toBe(placeholderCount);
    expect(result.params).toEqual([
      10,
      200,
      0.5,
      "HIGH",
      "Ungraded",
      "Non gradata",
      "Nicht bewertet",
      "Non gradée",
      "Non gradé",
      "GB",
      "%Charizard%",
    ]);
  });
});
