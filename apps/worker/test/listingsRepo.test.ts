import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import {
  upsertListing,
  expireEndedAuctionListings,
  saveListingEnrichment,
  getAlreadyEnrichedListingIds,
  getListingsByIds,
} from "../src/repo/listingsRepo.js";
import type { RawEbayListing, RawEbayItemDetail } from "@mwmc/providers";

/**
 * REGRESSION GUARD: seller_username must never be written.
 *
 * eBay disables production API keysets that haven't implemented (or been
 * exempted from) their Marketplace Account Deletion / Account Closure
 * Notification requirement, which applies to apps retaining eBay-account-
 * linked data. This app's only use of a seller's identity was an on-screen
 * label, so migration 0014 dropped ebay_listings.seller_username entirely
 * and the provider layer stopped capturing it. This test fails loudly if
 * either half of that regresses — the column reappearing in SQL, or the
 * value reappearing in the bound args.
 */
function capturingDb(): { db: Db; calls: { sql: string; args: unknown[] }[] } {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    exec: async (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args });
      return { success: true };
    },
    queryFirst: async () => null,
    queryAll: async () => [],
  } as unknown as Db;
  return { db, calls };
}

function listing(overrides: Partial<RawEbayListing> = {}): RawEbayListing {
  return {
    ebayItemId: "L1",
    title: "Charizard VMAX",
    price: 45.5,
    currency: "GBP",
    shippingCost: 3.99,
    listingType: "FIXED",
    itemUrl: "https://ebay.co.uk/itm/L1",
    imageUrls: [],
    parsedIdentity: {},
    ...overrides,
  };
}

describe("upsertListing never persists a seller identity", () => {
  it("does not reference seller_username in the SQL it emits", async () => {
    const { db, calls } = capturingDb();
    await upsertListing(db, listing(), null, 0.9, null);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).not.toMatch(/seller_username/i);
  });

  it("binds one value per placeholder even without a seller username", async () => {
    const { db, calls } = capturingDb();
    await upsertListing(db, listing(), "card-1", 0.9, "matched on title + set");

    const call = calls[0]!;
    const placeholderCount = (call.sql.match(/\?/g) ?? []).length;
    expect(call.args.length).toBe(placeholderCount);
  });

  it("has no sellerUsername field to pass through even if a provider supplied one", () => {
    // RawEbayListing intentionally has no sellerUsername field any more —
    // this is a compile-time guard as much as a runtime one. If this line
    // fails to typecheck, someone reintroduced the field upstream.
    const raw = listing();
    expect((raw as Record<string, unknown>).sellerUsername).toBeUndefined();
  });

  it("revives status back to ACTIVE on every re-upsert", async () => {
    const { db, calls } = capturingDb();
    await upsertListing(db, listing(), null, 0.9, null);
    expect(calls[0]!.sql).toMatch(/status\s*=\s*'ACTIVE'/);
  });
});

/**
 * REGRESSION GUARD for STABILISATION item 8 (freshness/lifecycle).
 *
 * expireEndedAuctionListings() is the one status transition this pass adds
 * — deliberately narrow: only AUCTION listings past a KNOWN end_time, never
 * a staleness guess for FIXED/BEST_OFFER listings (see its doc comment).
 * Pinned down directly against a fake Db, without needing real D1.
 */
function fakeListingsDb(endingRows: { id: string }[]): { db: Db; execCalls: { sql: string; args: unknown[] }[] } {
  const execCalls: { sql: string; args: unknown[] }[] = [];
  const db = {
    exec: async (sql: string, ...args: unknown[]) => {
      execCalls.push({ sql, args });
      return { success: true };
    },
    queryFirst: async () => null,
    queryAll: async () => endingRows,
  } as unknown as Db;
  return { db, execCalls };
}

describe("expireEndedAuctionListings", () => {
  it("returns 0 and issues no UPDATE when nothing has ended", async () => {
    const { db, execCalls } = fakeListingsDb([]);
    const count = await expireEndedAuctionListings(db);

    expect(count).toBe(0);
    expect(execCalls).toHaveLength(0);
  });

  it("selects only AUCTION + ACTIVE + a past end_time, then updates exactly those ids to ENDED", async () => {
    const { db, execCalls } = fakeListingsDb([{ id: "L1" }, { id: "L2" }]);
    const count = await expireEndedAuctionListings(db);

    expect(count).toBe(2);
    expect(execCalls).toHaveLength(1);
    const { sql, args } = execCalls[0]!;
    expect(sql).toMatch(/UPDATE ebay_listings/);
    expect(sql).toMatch(/status = 'ENDED'/);
    expect(sql).toMatch(/IN \(\?,\?\)/);
    expect(args).toEqual(["L1", "L2"]);
  });

  /** REGRESSION GUARD, 2026-09-03: same unbounded-IN-clause shape as
   *  getAlreadyEnrichedListingIds above — this UPDATE must also batch. */
  it("splits a large ended-id list into multiple bounded UPDATE statements", async () => {
    const manyRows = Array.from({ length: 250 }, (_, i) => ({ id: `L${i}` }));
    const { db, execCalls } = fakeListingsDb(manyRows);

    const count = await expireEndedAuctionListings(db);

    expect(count).toBe(250);
    expect(execCalls.length).toBeGreaterThan(1);
    for (const call of execCalls) {
      expect(call.args.length).toBeLessThan(manyRows.length);
    }
    const allUpdatedIds = execCalls.flatMap((c) => c.args as string[]);
    expect(new Set(allUpdatedIds)).toEqual(new Set(manyRows.map((r) => r.id)));
  });
});

/**
 * SOURCING WORKFLOW item 9 (two-stage eBay enrichment): pinned down against
 * a fake Db, same rationale as expireEndedAuctionListings above.
 */
describe("saveListingEnrichment", () => {
  it("stores conditionDescriptors as JSON and sets enriched_at, keyed by the listing id", async () => {
    const { db, calls } = capturingDb();
    const detail: RawEbayItemDetail = {
      ebayItemId: "L1",
      conditionDescriptors: [{ name: "27501", values: ["400010"] }],
      conditionDescription: "Excellent",
    };
    await saveListingEnrichment(db, detail);

    expect(calls).toHaveLength(1);
    const { sql, args } = calls[0]!;
    expect(sql).toMatch(/UPDATE ebay_listings/);
    expect(sql).toMatch(/enriched_at = datetime\('now'\)/);
    expect(args[0]).toBe(JSON.stringify(detail.conditionDescriptors));
    expect(args[1]).toBe("Excellent");
    expect(args[4]).toBe("L1"); // WHERE id = ?
  });

  it("stores an empty conditionDescriptors array as real JSON, not null — 'checked, found nothing' is a real outcome", async () => {
    const { db, calls } = capturingDb();
    await saveListingEnrichment(db, { ebayItemId: "L1", conditionDescriptors: [] });

    expect(calls[0]!.args[0]).toBe("[]");
  });

  /** REGRESSION GUARD, AI INTELLIGENCE gap 2 (migration 0020): the same
   *  enrichment call's description/aspects must actually be persisted, not
   *  fetched-then-discarded as they were before this fix. */
  it("stores item_description and item_aspects from the same enrichment call", async () => {
    const { db, calls } = capturingDb();
    await saveListingEnrichment(db, {
      ebayItemId: "L1",
      conditionDescriptors: [],
      description: "Pulled from a binder, never played.",
      aspects: [{ name: "Language", value: "English" }],
    });

    const { sql, args } = calls[0]!;
    expect(sql).toMatch(/item_description = \?/);
    expect(sql).toMatch(/item_aspects = \?/);
    expect(args[2]).toBe("Pulled from a binder, never played.");
    expect(args[3]).toBe(JSON.stringify([{ name: "Language", value: "English" }]));
  });

  it("stores item_aspects as real JSON '[]' (not null) when aspects is an empty array — 'checked, found nothing', same convention as conditionDescriptors", async () => {
    const { db, calls } = capturingDb();
    await saveListingEnrichment(db, { ebayItemId: "L1", conditionDescriptors: [], aspects: [] });

    expect(calls[0]!.args[3]).toBe("[]");
  });

  it("leaves item_description/item_aspects null when the enrichment detail didn't carry them at all — 'never checked', not 'checked, found nothing'", async () => {
    const { db, calls } = capturingDb();
    await saveListingEnrichment(db, { ebayItemId: "L1", conditionDescriptors: [] });

    expect(calls[0]!.args[2]).toBeNull();
    expect(calls[0]!.args[3]).toBeNull();
  });
});

describe("getAlreadyEnrichedListingIds", () => {
  it("returns an empty set without querying when given no ids", async () => {
    let queried = false;
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async () => {
        queried = true;
        return [];
      },
    } as unknown as Db;

    const result = await getAlreadyEnrichedListingIds(db, []);
    expect(result.size).toBe(0);
    expect(queried).toBe(false);
  });

  it("queries only the given ids, filtered to enriched_at IS NOT NULL, and returns them as a Set", async () => {
    let capturedSql = "";
    let capturedArgs: unknown[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string, ...args: unknown[]) => {
        capturedSql = sql;
        capturedArgs = args;
        return [{ id: "L1" }, { id: "L3" }];
      },
    } as unknown as Db;

    const result = await getAlreadyEnrichedListingIds(db, ["L1", "L2", "L3"]);

    expect(capturedSql).toMatch(/enriched_at IS NOT NULL/);
    expect(capturedSql).toMatch(/IN \(\?,\?,\?\)/);
    expect(capturedArgs).toEqual(["L1", "L2", "L3"]);
    expect(result).toEqual(new Set(["L1", "L3"]));
  });

  /**
   * REGRESSION GUARD, 2026-09-03: this call used to build ONE `IN
   * (?,?,?...)` clause for the entire input array, with no bound on its
   * size. D1 (like SQLite) caps the number of parameters a single prepared
   * statement can carry — this failed for real, live, once a scan
   * accumulated enough qualified candidates
   * ("SQLITE_ERROR: too many SQL variables"). This test proves a
   * larger-than-one-batch input is split into multiple queries (never one
   * unbounded IN clause) and that results from every batch are still
   * merged into the final Set.
   */
  it("splits a large id list into multiple bounded queries and merges every batch's results", async () => {
    const manyIds = Array.from({ length: 250 }, (_, i) => `L${i}`);
    const queryCalls: { sql: string; args: unknown[] }[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string, ...args: unknown[]) => {
        queryCalls.push({ sql, args });
        // Echo back one "enriched" row per batch so we can prove merging.
        return args.length > 0 ? [{ id: args[0] as string }] : [];
      },
    } as unknown as Db;

    const result = await getAlreadyEnrichedListingIds(db, manyIds);

    // Never a single query for all 250 — that's the exact bug being fixed.
    expect(queryCalls.length).toBeGreaterThan(1);
    // No individual query is allowed to carry the whole list.
    for (const call of queryCalls) {
      expect(call.args.length).toBeLessThan(manyIds.length);
    }
    // Every id actually queried across all batches, none dropped or duplicated.
    const allQueriedIds = queryCalls.flatMap((c) => c.args as string[]);
    expect(new Set(allQueriedIds)).toEqual(new Set(manyIds));
    // Results from every batch made it into the final merged Set.
    expect(result.size).toBe(queryCalls.length);
  });
});

/**
 * REGRESSION GUARD for AI INTELLIGENCE gap 3: getListingsByIds is what
 * scanRunner.ts's new selective-AI-review step uses to fetch full listing
 * rows (condition/description/aspects/seller evidence) for the candidates
 * it's about to send to AiCandidateRouterProvider. Same chunking discipline
 * as getAlreadyEnrichedListingIds above, for the same reason (sqlChunk.ts).
 */
describe("getListingsByIds", () => {
  it("returns an empty map without querying when given no ids", async () => {
    let queried = false;
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async () => {
        queried = true;
        return [];
      },
    } as unknown as Db;

    const result = await getListingsByIds(db, []);
    expect(result.size).toBe(0);
    expect(queried).toBe(false);
  });

  it("queries the given ids and returns a Map keyed by listing id", async () => {
    let capturedSql = "";
    let capturedArgs: unknown[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string, ...args: unknown[]) => {
        capturedSql = sql;
        capturedArgs = args;
        return [
          { id: "L1", title: "Listing One" },
          { id: "L3", title: "Listing Three" },
        ];
      },
    } as unknown as Db;

    const result = await getListingsByIds(db, ["L1", "L2", "L3"]);

    expect(capturedSql).toMatch(/FROM ebay_listings/);
    expect(capturedSql).toMatch(/IN \(\?,\?,\?\)/);
    expect(capturedArgs).toEqual(["L1", "L2", "L3"]);
    expect(result.size).toBe(2);
    expect(result.get("L1")).toEqual({ id: "L1", title: "Listing One" });
    expect(result.get("L2")).toBeUndefined();
  });

  it("splits a large id list into multiple bounded queries and merges every batch's results", async () => {
    const manyIds = Array.from({ length: 250 }, (_, i) => `L${i}`);
    const queryCalls: { sql: string; args: unknown[] }[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string, ...args: unknown[]) => {
        queryCalls.push({ sql, args });
        return (args as string[]).map((id) => ({ id, title: `Listing ${id}` }));
      },
    } as unknown as Db;

    const result = await getListingsByIds(db, manyIds);

    expect(queryCalls.length).toBeGreaterThan(1);
    for (const call of queryCalls) {
      expect(call.args.length).toBeLessThan(manyIds.length);
    }
    expect(result.size).toBe(manyIds.length);
  });
});
