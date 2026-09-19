import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeGradeRules, applyDashboardFilters, buildServerFilterParams, buyGradeProfit, DEFAULT_DASHBOARD_FILTERS } from "../src/state/filters";
import type { DashboardFilters } from "../src/state/filters";

/**
 * THINGS FOUND BY USING THE DEPLOYED APP — 2026-09-19.
 *
 * Two real defects, and one guard whose original write-up was wrong.
 *
 * The two real ones came from the code and stand on their own: a result
 * count that contradicted the table beneath it, and an empty grade view
 * that blamed the market for what was actually missing data. 1,500-odd unit
 * tests were green through both, because they test what the code computes
 * and neither of these is a computation.
 *
 * The third — the wheel guard — was reported as a dramatic live bug on the
 * strength of one unverified observation, and was not. See its own comment
 * below. Left in because the guard is worth having and the mistake is worth
 * remembering.
 */

const filters = (over: Partial<DashboardFilters>): DashboardFilters => ({
  ...DEFAULT_DASHBOARD_FILTERS,
  strategy: "GRADE",
  ...over,
});

/** A GRADE row that clears every default filter. */
const gradeRow = (over: Record<string, unknown> = {}) =>
  ({
    strategy: "GRADE",
    state: "QUALIFIED_GRADE",
    listing_type: "FIXED",
    total_acquisition_cost: 50,
    total_graded_basis: 100,
    psa10_value: 500,
    psa10_profit: 300,
    psa7_profit: 80,
    break_even_grade: "6",
    required_psa10_rate_vs_psa9: 0,
    estimated_capital_lock_days: 90,
    economic_class: "BALANCED",
    grader_id: "PSA",
    grading_service_id: "PSA_STANDARD",
    liquidity: "HIGH",
    confidence: 0.8,
    ...over,
  }) as never;

/**
 * THE WHEEL GUARD — and a correction.
 *
 * This was first written up as a serious live bug: two filter values seen
 * changing during a scroll, reported as a stray wheel silently emptying the
 * feed. The operator had typed those values himself. A later test on the
 * live site, scrolling directly over the input, did not move it.
 *
 * The real behaviour is narrower: a browser changes a number input on wheel
 * only while it HAS FOCUS. Click into a filter, scroll without clicking
 * away, and it moves. Worth guarding on a bar with nine of them above the
 * results; not the dramatic failure first claimed.
 */
describe("no number input can be changed by scrolling past it", () => {
  const source = readFileSync(join(__dirname, "../src/components/FilterBar.tsx"), "utf8");

  it("guards every number input", () => {
    const numberInputs = source.match(/type="number"/g)?.length ?? 0;
    const guards = source.match(/onWheel=\{ignoreWheel\}/g)?.length ?? 0;

    expect(numberInputs).toBeGreaterThan(0);
    expect(guards).toBe(numberInputs);
  });

  it("blurs rather than calling preventDefault, which is unreliable on a passive wheel listener", () => {
    expect(source).toMatch(/function ignoreWheel[\s\S]{0,200}blur\(\)/);
  });
});

/**
 * DEFECT 2 — TWO NUMBERS THAT DISAGREED.
 *
 * The page read "2,896 matching listings · page 1 of 39" directly above
 * "No opportunities match the current filters."
 *
 * Both were true. `total` is the server's count; the rows are then filtered
 * AGAIN in the browser, and when that second pass removes everything the
 * count describes a different set from the table. These tests pin the
 * behaviour that makes the gap real, so that anyone changing it knows the
 * contradiction is structural and has to stay explained on screen.
 */
describe("the browser filters rows the server already counted", () => {
  const row = (over: Record<string, unknown> = {}) => gradeRow({ psa3_profit: null, ...over });

  it("can remove every row of a page the server counted as matching", () => {
    const serverPage = [row(), row(), row()];

    const shown = applyDashboardFilters(serverPage, filters({ buyGrade: 7, minBuyGradeProfit: 1000 }));

    // Three rows counted, none shown — exactly the state that produced the
    // contradictory screen.
    expect(serverPage.length).toBe(3);
    expect(shown.length).toBe(0);
  });

  it("leaves them alone when the browser-side floor is off", () => {
    const serverPage = [row(), row(), row()];

    expect(applyDashboardFilters(serverPage, filters({ minBuyGradeProfit: -Infinity })).length).toBe(3);
  });
});

/**
 * DEFECT 3 — BLAMING THE MARKET FOR MISSING DATA.
 *
 * Choosing PSA 1 to 5 emptied the feed and the screen said "no
 * opportunities match the current filters" — a claim about the MARKET. The
 * truth was about OUR DATA: psa1_profit through psa5_profit arrived with
 * migration 0029, so every opportunity computed before it is NULL at those
 * grades, and a NULL never clears a profit floor.
 *
 * "Nothing pays at a PSA 3" and "nothing here has been priced at a PSA 3"
 * are opposite conclusions for someone deciding what to buy. The first says
 * the strategy does not work; the second says wait for the next scan.
 */
describe("a blank grade is missing data, not a zero", () => {
  const unpriced = gradeRow({ psa3_profit: null, psa7_profit: 120 });

  it("reads a blank low grade as unknown", () => {
    expect(buyGradeProfit(unpriced, 3)).toBeNull();
  });

  /**
   * THE RULE THAT MUST NOT CHANGE. Reading a blank as 0 would let every
   * unpriced card clear a floor of "at least £0" and flood the feed with
   * cards nobody has valued at that grade.
   */
  it("never lets a blank clear a profit floor", () => {
    const shown = applyDashboardFilters([unpriced], filters({ buyGrade: 3, minBuyGradeProfit: 0 }));

    expect(shown.length).toBe(0);
  });

  it("still shows the same card at a grade that IS priced", () => {
    const shown = applyDashboardFilters([gradeRow({ psa3_profit: null, psa7_profit: 120 })], filters({ buyGrade: 7, minBuyGradeProfit: 100 }));

    expect(shown.length).toBe(1);
  });
});

/**
 * THE 75-OF-75 BUG — found on the live Grade tab, 2026-09-19.
 *
 * The page read "1,536 matching listings · 75 hidden on this page by
 * filters applied here" directly above "No opportunities match the current
 * filters". Every row the server sent was discarded by the browser.
 *
 * `minPsa10Profit` defaults to 0. The server-param builder treats 0 as OFF
 * and sends no clause. The client filter treated it as a FLOOR of zero, so
 * every row with a negative PSA 10 profit — and every row where that column
 * is NULL — was dropped after arriving. There is no control for it, so
 * nobody set it and nobody could see it was set.
 *
 * These tests assert the two sides AGREE, rather than asserting either
 * one's behaviour, because agreement is the property that was missing.
 */
describe("the server and the browser apply the same grade rules", () => {
  const loser = gradeRow({ psa10_profit: -50 });
  const unpriced = gradeRow({ psa10_profit: null });

  it("does not drop a row for a PSA 10 profit floor nobody set", () => {
    const shown = applyDashboardFilters([loser, unpriced], filters({}));

    expect(DEFAULT_DASHBOARD_FILTERS.minPsa10Profit).toBe(0);
    expect(shown.length).toBe(2);
  });

  it("keeps the floor working when it is actually set", () => {
    const shown = applyDashboardFilters([loser, gradeRow({ psa10_profit: 500 })], filters({ minPsa10Profit: 100 }));

    expect(shown.length).toBe(1);
  });

  /**
   * THE PROPERTY THAT MATTERS. For every rule, "the browser enforces it"
   * and "the server was told about it" must be the same answer. When they
   * differ you get a count describing one set and a table showing another,
   * which is unreadable and looks like the tool is broken.
   */
  it("sends a clause for exactly the rules it enforces locally", () => {
    for (const f of [
      filters({}),
      filters({ minPsa10Profit: 0 }),
      filters({ minPsa10Profit: 100 }),
      filters({ minPsa10Value: 0 }),
      filters({ minBuyGradeProfit: -Infinity }),
      filters({ minBuyGradeProfit: 25 }),
      filters({ maxTotalGradedBasis: Infinity }),
      filters({ maxTotalGradedBasis: 800 }),
    ]) {
      const active = activeGradeRules(f);
      const params = buildServerFilterParams(f);

      expect(params.minPsa10Profit !== undefined).toBe(active.minPsa10Profit);
      expect(params.minPsa10Value !== undefined).toBe(active.minPsa10Value);
      expect(params.minBuyGradeProfit !== undefined).toBe(active.minBuyGradeProfit);
      expect(params.maxTotalGradedBasis !== undefined).toBe(active.maxTotalGradedBasis);
    }
  });

  /**
   * A sentinel meaning "no minimum" must never become a clause, or the
   * defaults start excluding rows whose column is merely unknown.
   */
  it("treats every no-minimum sentinel as off", () => {
    const off = activeGradeRules(filters({ minPsa10Profit: 0, minPsa10Value: 0, minBuyGradeProfit: -Infinity, maxTotalGradedBasis: Infinity }));

    expect(off).toEqual({ minPsa10Value: false, minPsa10Profit: false, minBuyGradeProfit: false, maxTotalGradedBasis: false });
  });
});
