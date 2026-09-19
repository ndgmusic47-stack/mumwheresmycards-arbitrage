import { describe, it, expect } from "vitest";
import type { Db } from "@mwmc/db";
import { markVanishedListingsRemoved } from "../src/repo/listingsRepo.js";
import { buildFilterConditions } from "../src/routes/opportunities.js";

/**
 * REGRESSION GUARD for the 2026-09-09 "sold and ended listings leave the feed
 * automatically" change.
 *
 * eBay never tells this app that a fixed-price listing has sold — it just
 * stops appearing in search results. So absence is the only available signal,
 * and absence is DANGEROUS: read carelessly it hides listings that are alive
 * and well. These tests pin the two guards that make it safe, because a false
 * positive here silently removes a real opportunity from the user's feed and
 * nothing anywhere would report it.
 */
function fakeDb(activeRows: { id: string; price: number }[]) {
  const execs: { sql: string; params: unknown[] }[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    queryAll: async (sql: string, ...params: unknown[]) => {
      queries.push({ sql, params });
      const ceiling = params[1] as number | null;
      // Shaped like the real SELECT since migration 0030: the classifier reads
      // listing_type/bids/end_time/price, and a fake that returns only `id`
      // would let a regression in that read pass unnoticed.
      return activeRows
        .filter((r) => ceiling === null || r.price <= ceiling)
        .map((r) => ({ id: r.id, listing_type: "FIXED", bids: null, end_time: null, price: r.price }));
    },
    queryFirst: async () => null,
    exec: async (sql: string, ...params: unknown[]) => {
      execs.push({ sql, params });
      return { success: true };
    },
  } as unknown as Db;
  return { db, execs, queries };
}

describe("inferring that a listing has sold", () => {
  it("marks a stored ACTIVE listing REMOVED when a complete search didn't return it", async () => {
    const { db, execs } = fakeDb([
      { id: "still-there", price: 30 },
      { id: "gone", price: 40 },
    ]);

    const n = await markVanishedListingsRemoved(db, "card-1", new Set(["still-there"]), null);

    expect(n).toBe(1);
    expect(execs).toHaveLength(1);
    // Since migration 0030 the status is BOUND rather than literal, because a
    // proven auction sale writes SOLD and everything else writes REMOVED.
    // This row has no auction facts, so it must still be REMOVED — the
    // conservative answer, unchanged.
    expect(execs[0]!.params[0]).toBe("REMOVED");
    expect(execs[0]!.params[1]).toBe("VANISHED");
    // Only the missing one, and only if it is STILL active — the guard means
    // two runs racing can't double-count or resurrect a decision.
    expect(execs[0]!.sql).toMatch(/AND status = 'ACTIVE'/);
    expect(execs[0]!.params).toContain("gone");
  });

  it("does nothing when every stored listing came back", async () => {
    const { db, execs } = fakeDb([{ id: "a", price: 10 }, { id: "b", price: 20 }]);
    const n = await markVanishedListingsRemoved(db, "card-1", new Set(["a", "b"]), null);
    expect(n).toBe(0);
    expect(execs).toEqual([]);
  });

  it("NEVER judges a listing priced above the ceiling the search actually applied", async () => {
    // THE false-positive that matters. Searches carry a maxPrice derived from
    // the card's economics, so a listing dearer than that is excluded BY EBAY,
    // not missing FROM eBay. Judging it absent would remove a live listing.
    const { db, execs, queries } = fakeDb([
      { id: "cheap-and-gone", price: 25 },
      { id: "dear-and-alive", price: 500 },
    ]);

    const n = await markVanishedListingsRemoved(db, "card-1", new Set(), 100);

    expect(n).toBe(1);
    // One update, and it names only the listing that was actually judged.
    expect(execs).toHaveLength(1);
    expect(execs[0]!.params).toContain("cheap-and-gone");
    expect(execs[0]!.params).not.toContain("dear-and-alive");
    // The ceiling is applied in SQL, not after the fact.
    expect(queries[0]!.sql).toMatch(/price <= \?/);
    expect(queries[0]!.params).toEqual(["card-1", 100, 100]);
  });

  it("only ever considers rows that are currently ACTIVE for this card", async () => {
    const { db, queries } = fakeDb([{ id: "a", price: 10 }]);
    await markVanishedListingsRemoved(db, "card-1", new Set(["a"]), null);
    expect(queries[0]!.sql).toMatch(/card_id = \?/);
    expect(queries[0]!.sql).toMatch(/status = 'ACTIVE'/);
  });
});

describe("dead listings are kept out of the working feed", () => {
  it("filters on eBay listing state when asked", () => {
    const { clause, params } = buildFilterConditions(new URLSearchParams({ listingStatus: "ACTIVE" }));
    expect(clause).toContain("l.status IN (?)");
    expect(params).toEqual(["ACTIVE"]);
  });

  it("adds no clause when a caller deliberately omits it (Pipeline's saved leads)", () => {
    const { clause, params } = buildFilterConditions(new URLSearchParams({}));
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });
});
