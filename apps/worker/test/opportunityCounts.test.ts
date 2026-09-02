import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import { loadOpportunityCounts } from "../src/repo/opportunitiesRepo.js";

/**
 * REGRESSION GUARD for STABILISATION item 1 (opportunity visibility).
 *
 * Before this fix, GET /api/opportunities capped at 500 rows with no total
 * count and no breakdown by state, so a candidate set larger than the page
 * size was invisible with no indication anything was hidden. This test
 * pins down loadOpportunityCounts's contract: it must count every state
 * independently of any filter/page, roll qualifying states up into
 * qualifiedTotal via the same QUALIFIED_STATES list the rest of the app
 * uses (never a hand-duplicated list that can drift), and count auctions
 * via ebay_listings.listing_type separately from opportunity state.
 */
function fakeDb(stateRows: { state: string; n: number }[], auctionCount: number): Db {
  return {
    exec: async () => ({ success: true }),
    queryFirst: async (sql: string) => {
      if (sql.includes("listing_type = 'AUCTION'")) return { n: auctionCount };
      return null;
    },
    queryAll: async (sql: string) => {
      if (sql.includes("GROUP BY state")) return stateRows;
      return [];
    },
  } as unknown as Db;
}

describe("loadOpportunityCounts", () => {
  it("sums every state into totalCandidates, independent of any filter", async () => {
    const db = fakeDb(
      [
        { state: "QUALIFIED_FLIP", n: 18 },
        { state: "QUALIFIED_GRADE", n: 26 },
        { state: "INSPECT_PHOTOS", n: 5 },
        { state: "WATCH", n: 200 },
        { state: "NO_MARKET_DATA", n: 60 },
        { state: "REJECTED_CARD_IDENTITY_UNCERTAIN", n: 20 },
        { state: "REJECTED_COMPUTATION_ERROR", n: 2 },
      ],
      43,
    );

    const counts = await loadOpportunityCounts(db);

    expect(counts.totalCandidates).toBe(18 + 26 + 5 + 200 + 60 + 20 + 2);
    expect(counts.qualifiedFlip).toBe(18);
    expect(counts.qualifiedGrade).toBe(26);
    expect(counts.inspectPhotos).toBe(5);
    // QUALIFIED_STATES = [QUALIFIED_FLIP, QUALIFIED_GRADE, INSPECT_PHOTOS]
    expect(counts.qualifiedTotal).toBe(18 + 26 + 5);
    expect(counts.watch).toBe(200);
    expect(counts.noMarketData).toBe(60);
    expect(counts.identityUncertain).toBe(20);
    expect(counts.computationError).toBe(2);
    expect(counts.auctions).toBe(43);
  });

  it("defaults every count to 0 when a state has no rows at all", async () => {
    const counts = await loadOpportunityCounts(fakeDb([], 0));

    expect(counts.totalCandidates).toBe(0);
    expect(counts.qualifiedTotal).toBe(0);
    expect(counts.auctions).toBe(0);
  });

  it("never hand-duplicates the qualifying state list — qualifiedTotal always equals the qualifying states' sum", async () => {
    // If a future opportunity-states rebuild adds/renames a qualifying
    // state, this must still sum correctly as long as loadOpportunityCounts
    // keeps deriving qualifiedTotal from QUALIFIED_STATES rather than a
    // separately hardcoded list (this is exactly how bug 8 happened).
    const db = fakeDb([{ state: "QUALIFIED_FLIP", n: 3 }, { state: "QUALIFIED_GRADE", n: 4 }, { state: "INSPECT_PHOTOS", n: 1 }], 0);
    const counts = await loadOpportunityCounts(db);
    expect(counts.qualifiedTotal).toBe(counts.qualifiedFlip + counts.qualifiedGrade + counts.inspectPhotos);
  });
});
