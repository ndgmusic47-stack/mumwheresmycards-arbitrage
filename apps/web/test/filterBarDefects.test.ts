import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDashboardFilters, buyGradeProfit, DEFAULT_DASHBOARD_FILTERS } from "../src/state/filters";
import type { DashboardFilters } from "../src/state/filters";

/**
 * THREE DEFECTS FOUND BY USING THE DEPLOYED APP — 2026-09-19.
 *
 * Not by reading code, and not by a test. By opening the operator's live
 * dashboard, clicking the Grade tab, and scrolling. Every one of them had
 * been shipped and running for weeks.
 *
 * Worth recording because the pattern repeats in this project: the unit
 * tests were green the whole time. They test what the code computes. None
 * of them could see a filter silently rewriting itself under a mouse
 * wheel, or a count contradicting the table beneath it, or an empty screen
 * blaming the market for missing data.
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
 * DEFECT 1 — THE SCROLL BUG.
 *
 * A browser increments a number input when the wheel turns over it. The
 * filter bar has nine, directly above the results table. Scrolling the page
 * changed "Max to pay for the card" from 1000 to 40 and "Min PSA10 value"
 * from 80 to 1000, and the feed emptied, with nothing on screen saying a
 * filter had moved.
 *
 * Asserted against the source rather than a rendered DOM because this suite
 * has no browser environment — crude, but it pins the thing that actually
 * matters: that no number input is left unguarded. A DOM test that mounted
 * the bar and fired a wheel event would be better and is worth doing when
 * this suite grows a renderer.
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
