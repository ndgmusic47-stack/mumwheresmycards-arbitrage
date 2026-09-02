import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import { upsertListing, expireEndedAuctionListings } from "../src/repo/listingsRepo.js";
import type { RawEbayListing } from "@mwmc/providers";

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
});
