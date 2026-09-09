import { describe, it, expect, beforeEach } from "vitest";
import {
  resultCache,
  resultCacheKey,
  writeResultCache,
  RESULT_CACHE_LIMIT,
  type CachedResult,
} from "../src/state/resultCache";
import type { OpportunityListItem, OpportunityQueryParams } from "../src/api/client";

/**
 * REGRESSION GUARD for the 2026-09-09 results cache.
 *
 * THE COMPLAINT it exists to answer: "I click a card to research it, come
 * back, and the page is loading a new batch — lost my place again."
 *
 * Filters and scroll position were already being restored. The DATA was not:
 * every return trip refetched, showed a spinner, and rebuilt the rows — which
 * ALSO made the scroll restore a race, because there was nothing in the DOM
 * to scroll until the fetch landed. Caching the rows is what turns the
 * position restore from "usually works" into "always works".
 *
 * The properties that matter, and what breaks if each is lost:
 *  - Key on the EXACT query. Miss this and a filter change silently shows
 *    the previous filter's rows, which is worse than a spinner.
 *  - Bounded. Miss this and a long session leaks every page ever viewed.
 *  - LRU by use, not by insertion. Miss this and the view you keep returning
 *    to gets evicted by pages you visited once.
 */
function params(overrides: Partial<OpportunityQueryParams> = {}): Omit<OpportunityQueryParams, "page"> {
  return { strategy: "GRADE", limit: 75, sort: "first_seen", dir: "desc", ...overrides };
}

function result(n: number): CachedResult {
  return {
    opportunities: Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }) as OpportunityListItem),
    total: n,
    pageCount: 1,
  };
}

beforeEach(() => resultCache.clear());

describe("the key is the exact query", () => {
  it("same query and page produce the same key", () => {
    expect(resultCacheKey(params(), 2)).toBe(resultCacheKey(params(), 2));
  });

  it("a different PAGE is a different entry", () => {
    expect(resultCacheKey(params(), 1)).not.toBe(resultCacheKey(params(), 2));
  });

  it("a different SORT is a different entry", () => {
    expect(resultCacheKey(params(), 1)).not.toBe(resultCacheKey(params({ sort: "psa10_profit" }), 1));
  });

  it("a different STRATEGY is a different entry — Grade must never show Flip's rows", () => {
    expect(resultCacheKey(params({ strategy: "GRADE" }), 1)).not.toBe(resultCacheKey(params({ strategy: "FLIP" }), 1));
  });

  it("any changed filter value is a different entry, so a tightened filter always refetches", () => {
    const loose = resultCacheKey({ ...params(), maxBreakEvenGrade: 9 } as Omit<OpportunityQueryParams, "page">, 1);
    const tight = resultCacheKey({ ...params(), maxBreakEvenGrade: 7 } as Omit<OpportunityQueryParams, "page">, 1);
    expect(loose).not.toBe(tight);
  });
});

describe("round trip", () => {
  it("stores and returns the same rows", () => {
    const key = resultCacheKey(params(), 1);
    writeResultCache(key, result(3));
    expect(resultCache.get(key)?.opportunities.map((o) => o.id)).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("a write to the same key replaces rather than duplicating", () => {
    const key = resultCacheKey(params(), 1);
    writeResultCache(key, result(3));
    writeResultCache(key, result(5));
    expect(resultCache.size).toBe(1);
    expect(resultCache.get(key)?.total).toBe(5);
  });

  it("an unvisited view is a miss, so it fetches properly instead of showing nothing", () => {
    writeResultCache(resultCacheKey(params(), 1), result(3));
    expect(resultCache.get(resultCacheKey(params(), 4))).toBeUndefined();
  });
});

describe("it stays bounded", () => {
  it(`never exceeds ${RESULT_CACHE_LIMIT} entries`, () => {
    for (let page = 1; page <= RESULT_CACHE_LIMIT + 15; page++) {
      writeResultCache(resultCacheKey(params(), page), result(1));
    }
    expect(resultCache.size).toBe(RESULT_CACHE_LIMIT);
  });

  it("evicts the OLDEST, keeping what was written most recently", () => {
    for (let page = 1; page <= RESULT_CACHE_LIMIT + 1; page++) {
      writeResultCache(resultCacheKey(params(), page), result(1));
    }
    expect(resultCache.get(resultCacheKey(params(), 1))).toBeUndefined();
    expect(resultCache.get(resultCacheKey(params(), RESULT_CACHE_LIMIT + 1))).toBeDefined();
  });

  it("re-writing a view refreshes its place in the queue, so the view you keep returning to survives", () => {
    const favourite = resultCacheKey(params(), 1);
    writeResultCache(favourite, result(1));
    // Fill to the brim with other pages...
    for (let page = 2; page <= RESULT_CACHE_LIMIT; page++) {
      writeResultCache(resultCacheKey(params(), page), result(1));
    }
    // ...touch the favourite again (what returning from a card detail does)...
    writeResultCache(favourite, result(2));
    // ...then push one more in. The favourite must NOT be the casualty.
    writeResultCache(resultCacheKey(params(), 999), result(1));

    expect(resultCache.get(favourite)).toBeDefined();
    expect(resultCache.get(resultCacheKey(params(), 2))).toBeUndefined();
  });
});

describe("a scan clears everything", () => {
  it("clear() empties the cache, because a scan changes prices, rows and listing status", () => {
    for (let page = 1; page <= 5; page++) writeResultCache(resultCacheKey(params(), page), result(1));
    resultCache.clear();
    expect(resultCache.size).toBe(0);
  });
});
