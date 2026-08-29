import { describe, it, expect } from "vitest";
import { MockCatalogueProvider } from "../src/catalogue/MockCatalogueProvider.js";
import { CATALOGUE_CARD_FIXTURES } from "../src/fixtures/catalogue.fixtures.js";

describe("MockCatalogueProvider", () => {
  it("paginates through the full fixture set using a cursor, ending with hasMore=false", async () => {
    const provider = new MockCatalogueProvider();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = await provider.fetchPage(cursor, 2);
      seen.push(...page.cards.map((c) => c.providerCardId));
      cursor = page.nextCursor;
      pages++;
      expect(page.hasMore).toBe(cursor !== null);
    } while (cursor !== null && pages < 20);

    expect(seen).toHaveLength(CATALOGUE_CARD_FIXTURES.length);
    expect(new Set(seen).size).toBe(CATALOGUE_CARD_FIXTURES.length); // no duplicates
    expect(pages).toBeGreaterThan(1); // pagination actually happened
  });

  it("returns hasMore=false and nextCursor=null on the last page", async () => {
    const provider = new MockCatalogueProvider();
    const page = await provider.fetchPage(String(CATALOGUE_CARD_FIXTURES.length - 1), 2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.cards).toHaveLength(1);
  });

  it("fetchSets returns set metadata including release years", async () => {
    const provider = new MockCatalogueProvider();
    const sets = await provider.fetchSets();
    const baseSet = sets.find((s) => s.setCode === "base-set");
    expect(baseSet?.year).toBe(1999);
  });
});
