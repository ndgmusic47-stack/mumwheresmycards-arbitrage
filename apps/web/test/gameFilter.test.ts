import { describe, it, expect } from "vitest";
import { buildServerFilterParams, DEFAULT_DASHBOARD_FILTERS } from "../src/state/filters";
import type { DashboardFilters } from "../src/state/filters";

/**
 * THE GAME FILTER — 2026-09-19.
 *
 * The backend became multi-game before the UI knew games existed: the word
 * did not appear anywhere in apps/web. The operator caught it — "the UI
 * needs to meet the expansion" — and he was right, because switching a
 * second game on in that state would have made the feed WORSE. One Piece
 * cards would have landed in the same list as Pokémon ones with nothing to
 * tell them apart and no way to separate them. A clean list turned into a
 * mixed one.
 *
 * These tests are mostly about the empty case, because that is where a
 * filter like this goes wrong: "no games selected" has to mean EVERY game,
 * and it has to reach the server as silence rather than as an empty filter
 * that matches nothing.
 */
const filters = (over: Partial<DashboardFilters>): DashboardFilters => ({
  ...DEFAULT_DASHBOARD_FILTERS,
  strategy: "GRADE",
  ...over,
});

describe("no game selected means every game", () => {
  it("ships with an empty selection rather than a list of every known game", () => {
    // Listing all six supported games as the default would put four
    // checkboxes on screen that select nothing, because the tool has cards
    // for one or two of them. An operator reads that as broken.
    expect(DEFAULT_DASHBOARD_FILTERS.games).toEqual([]);
  });

  /**
   * THE ONE THAT MATTERS. An empty array must not become `game=` on the
   * query string — the server reads that as a filter and matches nothing,
   * so the feed would silently empty out with no filter visibly set. This
   * project has already had one silent-empty-feed bug and it cost days.
   */
  it("sends no game parameter at all when nothing is selected", () => {
    const params = buildServerFilterParams(filters({ games: [] }));

    expect(params.game).toBeUndefined();
    expect("game" in params).toBe(false);
  });
});

describe("a selection narrows the feed", () => {
  it("sends a single game", () => {
    expect(buildServerFilterParams(filters({ games: ["onepiece"] })).game).toBe("onepiece");
  });

  it("sends several as a comma-separated list, in the order chosen", () => {
    expect(buildServerFilterParams(filters({ games: ["pokemon", "onepiece"] })).game).toBe("pokemon,onepiece");
  });
});

/**
 * Game describes the CARD, not the trade — like "ships from" and unlike
 * every profit threshold. So it has to survive the early return that skips
 * economics filtering for categories that have no economics to filter on.
 * If it did not, a game selection would silently stop applying the moment
 * the operator switched to the Review or Passed tab, and rows from a game
 * they had filtered out would reappear.
 */
describe("the game filter is cross-cutting", () => {
  for (const category of ["ALL", "ACTIONABLE", "REVIEW", "NEAR_MISS", "PASSED"] as const) {
    it(`still applies in the ${category} view`, () => {
      const params = buildServerFilterParams(filters({ games: ["onepiece"], category }));

      expect(params.game).toBe("onepiece");
    });
  }

  it("applies under every strategy, since a card's game does not depend on the trade", () => {
    for (const strategy of ["ALL", "FLIP", "GRADE"] as const) {
      expect(buildServerFilterParams(filters({ games: ["magic"], strategy })).game).toBe("magic");
    }
  });
});
