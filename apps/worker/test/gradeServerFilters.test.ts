import { describe, it, expect } from "vitest";
import { buildFilterConditions } from "../src/routes/opportunities.js";

/**
 * REGRESSION GUARD for the 2026-09-08 "make the grade filters actually
 * filter" change.
 *
 * Before this, every GRADE-specific lever (economic class, PSA-multiple and
 * profit thresholds, break-even grade, required PSA10 rate, PSA8 loss
 * ceiling, grader/service pickers) was applied ONLY in the browser, over
 * whatever ~75 rows the current page happened to hold. Against the real
 * dataset — 12,362 qualified grade candidates — that pass could narrow less
 * than 1% of the set, so tightening a threshold appeared to do nothing and
 * the result count it produced was meaningless. The user's report was
 * exactly that: filtering felt like it wasn't working.
 *
 * Two things must hold, and the second matters more than the first:
 *  1. each lever produces a real SQL condition with its value bound; and
 *  2. NULL is treated the same way the client's applyDashboardFilters()
 *     treats it, so the client pass over the returned page agrees with the
 *     server rather than quietly removing a second, different set of rows.
 */
function build(params: Record<string, string>) {
  return buildFilterConditions(new URLSearchParams(params));
}

describe("grade filters — real server-side conditions", () => {
  it("emits nothing at all when no grade params are sent", () => {
    const { clause, params } = build({});
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });

  it("binds each numeric grade threshold to its own column", () => {
    const { clause, params } = build({
      maxTotalGradedBasis: "1500",
      minPsa10Value: "80",
      minPsa10Profit: "25",
      minPsa10GrossMultiple: "3",
      minPsa9Profit: "-10",
      maxRequiredPsa10Rate: "0.4",
      maxBreakEvenGrade: "9",
    });

    expect(clause).toContain("o.total_graded_basis <= ?");
    expect(clause).toContain("o.psa10_profit >= ?");
    expect(clause).toContain("o.psa9_profit >= ?");
    expect(clause).toContain("o.required_psa10_rate_vs_psa9 <= ?");
    // break_even_grade is a TEXT column holding a number — compare numerically,
    // or "10" would sort before "9" as a string.
    expect(clause).toContain("CAST(o.break_even_grade AS REAL) <= ?");
    expect(params).toEqual([80, 3, 1500, 25, -10, 0.4, 9]);
  });

  it("reads a NULL psa10_value/multiple as 0, matching the client's `?? 0`", () => {
    const { clause } = build({ minPsa10Value: "80", minPsa10GrossMultiple: "3" });
    expect(clause).toContain("COALESCE(o.psa10_value, 0) >= ?");
    expect(clause).toContain("COALESCE(o.psa10_gross_multiple, 0) >= ?");
  });

  it("keeps an unclassified row via the __NULL__ sentinel, matching the client", () => {
    const { clause, params } = build({ economicClass: "BALANCED,ASYMMETRIC,__NULL__" });
    expect(clause).toContain("COALESCE(o.economic_class, '__NULL__') IN (?,?,?)");
    expect(params).toEqual(["BALANCED", "ASYMMETRIC", "__NULL__"]);
  });

  it("lets a row it cannot evaluate pass the PSA8 loss ceiling, rather than counting it against itself", () => {
    const { clause, params } = build({ maxPsa8LossPctOfBasis: "0.25" });
    expect(clause).toContain("o.psa8_profit IS NULL");
    expect(clause).toContain("o.total_graded_basis IS NULL");
    expect(clause).toContain("o.total_graded_basis = 0");
    expect(clause).toContain("o.psa8_profit >= -ABS(o.total_graded_basis * ?)");
    expect(params).toEqual([0.25]);
  });

  it("filters by grader and grading service exactly", () => {
    const { clause, params } = build({ graderId: "psa", gradingServiceId: "psa-value" });
    expect(clause).toContain("o.grader_id = ?");
    expect(clause).toContain("o.grading_service_id = ?");
    expect(params).toEqual(["psa", "psa-value"]);
  });

  it("filters by review status, which is cross-cutting and safe under any strategy", () => {
    const { clause, params } = build({ reviewStatus: "INTERESTED" });
    expect(clause).toContain("o.review_status IN (?)");
    expect(params).toEqual(["INTERESTED"]);
  });

  it("ignores a blank or non-numeric value rather than emitting an always-false clause", () => {
    const { clause, params } = build({
      maxTotalGradedBasis: "",
      minPsa10Profit: "not-a-number",
      maxBreakEvenGrade: "",
      graderId: "",
      economicClass: "",
      reviewStatus: "",
    });
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });
});
