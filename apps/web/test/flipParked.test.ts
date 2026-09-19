import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLIP_ENABLED, DEFAULT_STRATEGY_TAB } from "../src/state/business";
import { applyDashboardFilters, buildServerFilterParams, DEFAULT_DASHBOARD_FILTERS } from "../src/state/filters";
import type { DashboardFilters } from "../src/state/filters";

/**
 * FLIP IS PARKED, AND THE SCREEN HAS TO AGREE — 2026-09-19.
 *
 * The scanner stopped looking for flips weeks ago. The UI did not, so the
 * operator kept opening a dashboard that LED with a "RAW FLIP" table,
 * offered six flip filters above the grading ones, carried a "Flips" tab,
 * and reported "dynamic flip markets" as a headline figure. He said so
 * three times before it was fixed.
 *
 * The lesson worth keeping: a business decision taken in the engine is not
 * taken until the screen shows it. Nothing here tests a calculation —
 * these are all about what a person sees.
 */
const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

describe("the flip business is off", () => {
  it("is off", () => {
    expect(FLIP_ENABLED).toBe(false);
  });

  /** ALL meant "flip and grade", and flip sorted first — which is why the
   *  operator's home screen opened on a flip table. */
  it("opens the main dashboard on grading rather than everything", () => {
    expect(DEFAULT_STRATEGY_TAB).toBe("GRADE");
  });

  it("does not offer a Flips tab in the navigation", () => {
    expect(src("App.tsx")).toMatch(/FLIP_ENABLED && <NavLink to="\/flip">/);
  });

  /** A bookmark from before flip was parked must land somewhere sensible
   *  rather than on a blank route. */
  it("still resolves the old /flip URL", () => {
    expect(src("App.tsx")).toMatch(/path="\/flip"/);
  });

  it("hides the flip block in the filter bar", () => {
    expect(src("components/FilterBar.tsx")).toMatch(/const showFlip = FLIP_ENABLED &&/);
  });

  it("stops reporting flip-only figures in the summary tiles", () => {
    const tiles = src("components/SummaryStats.tsx");
    expect(tiles).toMatch(/FLIP_ENABLED \? \[\{ label: "Dynamic flip markets"/);
  });
});

/**
 * The tiles also stopped saying Pokémon. The catalogue carries a game per
 * card now, so a hardcoded label would have gone on counting One Piece
 * cards while calling them Pokémon — wrong in the quietest possible way,
 * because the number would keep looking right.
 */
describe("the summary tiles do not name one game", () => {
  it("counts cards, not Pokémon", () => {
    const tiles = src("components/SummaryStats.tsx");
    expect(tiles).toContain('label: "Card singles indexed"');
    expect(tiles).not.toContain('label: "Pokémon singles indexed"');
  });
});

/**
 * PARKED, NOT DELETED. The flip economics are computed, stored and tested,
 * and thousands of flip rows already exist. Turning off a screen must not
 * quietly change what the engine does or what a stored row means.
 */
describe("parking flip changed no economics", () => {
  const filters = (over: Partial<DashboardFilters>): DashboardFilters => ({ ...DEFAULT_DASHBOARD_FILTERS, ...over });

  it("still filters flip rows correctly if the strategy is asked for", () => {
    const flipRow = {
      strategy: "FLIP",
      state: "QUALIFIED_FLIP",
      listing_type: "FIXED",
      expected_net_profit: 100,
      return_on_capital: 1,
      profit_margin: 0.5,
      total_acquisition_cost: 50,
      qsv: 200,
      days_to_sale_estimate: 10,
      liquidity: "HIGH",
      confidence: 0.9,
    } as never;

    expect(applyDashboardFilters([flipRow], filters({ strategy: "FLIP" })).length).toBe(1);
  });

  it("still builds flip query params when the strategy is FLIP", () => {
    const params = buildServerFilterParams(filters({ strategy: "FLIP" }));

    expect(params.minNetProfit).toBe(DEFAULT_DASHBOARD_FILTERS.minNetProfit);
  });
});
