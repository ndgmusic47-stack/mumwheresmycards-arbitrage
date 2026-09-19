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
      maxRequiredPsa10Rate: "0.4",
      maxBreakEvenGrade: "9",
    });

    expect(clause).toContain("o.total_graded_basis <= ?");
    expect(clause).toContain("o.psa10_profit >= ?");
    expect(clause).toContain("o.required_psa10_rate_vs_psa9 <= ?");
    // break_even_grade is a TEXT column holding a number — compare numerically,
    // or "10" would sort before "9" as a string.
    expect(clause).toContain("CAST(o.break_even_grade AS REAL) <= ?");
    expect(params).toEqual([80, 1500, 25, 0.4, 9]);
  });

  it("reads a NULL psa10_value as 0, matching the client's `?? 0`", () => {
    const { clause } = build({ minPsa10Value: "80" });
    expect(clause).toContain("COALESCE(o.psa10_value, 0) >= ?");
  });

  /*
   * THE BUY-GRADE FLOOR — 2026-09-13.
   *
   * The rule the low-grade strategy needs: profit at the grade actually being
   * bet on, which is usually a 6 or a 7. The grade names a COLUMN, so it is
   * checked against a fixed allowlist rather than interpolated.
   */
  it("binds the buy-grade profit floor to that grade's own column", () => {
    const { clause, params } = build({ buyGrade: "6", minBuyGradeProfit: "250" });
    expect(clause).toContain("o.psa6_profit >= ?");
    expect(params).toEqual([250]);
  });

  it("reads the floor against PSA 7 when that is the buy grade", () => {
    const { clause } = build({ buyGrade: "7", minBuyGradeProfit: "100" });
    expect(clause).toContain("o.psa7_profit >= ?");
    expect(clause).not.toContain("o.psa6_profit");
  });

  it("ignores a buy grade that is not on the allowlist, rather than building SQL from it", () => {
    // Two grades have left this list as the ladder grew. "10" went on
    // 2026-09-13 when the buy-grade rule absorbed the separate "Min PSA10
    // profit" control, and "5" went on 2026-09-19 when the scale widened to
    // PSA 1-10 — both are legitimate grades to ask for now.
    //
    // What must NOT change is why the list exists: the grade names a COLUMN
    // and is interpolated into SQL, so only an explicit allowlist of integers
    // makes that safe. Every entry below is still refused, including the half
    // grade — the ladder is whole numbers, and "5.5" naming no column must
    // fail closed rather than build one.
    for (const bad of ["0", "11", "5.5", "-1", "6; DROP TABLE opportunities", "psa6_profit"]) {
      const { clause } = build({ buyGrade: bad, minBuyGradeProfit: "250" });
      expect(clause).not.toContain("_profit >= ?");
    }
  });

  it("accepts 10 now that the rule spans the whole ladder", () => {
    const { clause, params } = build({ buyGrade: "10", minBuyGradeProfit: "250" });
    expect(clause).toContain("o.psa10_profit >= ?");
    expect(params).toContain(250);
  });

  it("does nothing without a floor, so selecting a grade alone narrows nothing", () => {
    const { clause } = build({ buyGrade: "6" });
    expect(clause).not.toContain("o.psa6_profit");
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
