import { describe, it, expect } from "vitest";
import { MockEbayProvider } from "../src/ebay/MockEbayProvider.js";

describe("MockEbayProvider", () => {
  it("matches fixtures by keyword containment (case-insensitive, all terms required)", async () => {
    const provider = new MockEbayProvider();
    const results = await provider.searchActiveListings({ keywords: "Charizard Base Set" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.title.toLowerCase()).toContain("charizard");
    }
  });

  it("returns an empty array when no fixture matches", async () => {
    const provider = new MockEbayProvider();
    const results = await provider.searchActiveListings({ keywords: "Definitely Not A Real Card Name Zzz" });
    expect(results).toEqual([]);
  });

  it("respects maxPrice filtering", async () => {
    const provider = new MockEbayProvider();
    const results = await provider.searchActiveListings({ keywords: "Umbreon", maxPrice: 160 });
    expect(results.every((r) => r.price <= 160)).toBe(true);
    expect(results.some((r) => r.ebayItemId === "ebay-fixture-003")).toBe(true);
    expect(results.some((r) => r.ebayItemId === "ebay-fixture-004")).toBe(false);
  });

  it("respects limit", async () => {
    const provider = new MockEbayProvider();
    const results = await provider.searchActiveListings({ keywords: "Umbreon", limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("allListings returns every fixture regardless of query", async () => {
    const provider = new MockEbayProvider();
    const all = await provider.allListings();
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  it("includes a fixture with an ambiguous/incomplete parsedIdentity for identity-resolution tests", async () => {
    const provider = new MockEbayProvider();
    const all = await provider.allListings();
    const ambiguous = all.find((l) => l.ebayItemId === "ebay-fixture-006");
    expect(ambiguous).toBeDefined();
    expect(Object.keys(ambiguous!.parsedIdentity).length).toBeLessThan(3);
  });

  describe("getItemDetail (SOURCING WORKFLOW item 9)", () => {
    it("returns a canned stub for the one fixture id it knows, clearly marked as fixture data", async () => {
      const provider = new MockEbayProvider();
      const detail = await provider.getItemDetail("ebay-fixture-001");
      expect(detail).not.toBeNull();
      expect(detail!.ebayItemId).toBe("ebay-fixture-001");
      expect(detail!.conditionDescriptors.length).toBeGreaterThan(0);
      expect(detail!.conditionDescription).toContain("fixture data");
    });

    it("returns null for every other id, matching the real provider's 'nothing richer available' contract", async () => {
      const provider = new MockEbayProvider();
      expect(await provider.getItemDetail("ebay-fixture-002")).toBeNull();
      expect(await provider.getItemDetail("not-a-real-id")).toBeNull();
    });
  });
});
