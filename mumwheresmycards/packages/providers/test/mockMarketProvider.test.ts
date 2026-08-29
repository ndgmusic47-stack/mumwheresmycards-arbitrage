import { describe, it, expect } from "vitest";
import { resolveCardPrinting } from "@mwmc/core";
import { MockMarketProvider } from "../src/market/MockMarketProvider.js";
import { MARKET_FIXTURE_IDENTITIES } from "../src/fixtures/market.fixtures.js";

describe("MockMarketProvider", () => {
  it("returns a snapshot for a fixture card", async () => {
    const provider = new MockMarketProvider();
    const printing = resolveCardPrinting(MARKET_FIXTURE_IDENTITIES[0]!).printing!;
    const snapshot = await provider.getSnapshot(printing);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.cardId).toBe(printing.printingHash);
    expect(snapshot!.sourceProvider).toBe("mock");
  });

  it("returns null for a card with no fixture (never synthesizes data)", async () => {
    const provider = new MockMarketProvider();
    const printing = resolveCardPrinting({
      game: "pokemon",
      name: "Totally Fake Card",
      setName: "Nonexistent Set",
      setCode: "XXX",
      cardNumber: "1/1",
      year: 2099,
      language: "EN",
      edition: "na",
      variant: "normal",
      finish: "na",
      rarity: "Common",
    }).printing!;
    expect(await provider.getSnapshot(printing)).toBeNull();
  });

  it("getSnapshotsBatch resolves multiple printings and skips missing ones", async () => {
    const provider = new MockMarketProvider();
    const known = resolveCardPrinting(MARKET_FIXTURE_IDENTITIES[0]!).printing!;
    const unknown = resolveCardPrinting({
      game: "pokemon",
      name: "Unknown",
      setName: "Unknown Set",
      setCode: "UNK",
      cardNumber: "0/0",
      year: 2000,
      language: "EN",
      edition: "na",
      variant: "normal",
      finish: "na",
      rarity: "Common",
    }).printing!;

    const results = await provider.getSnapshotsBatch!([known, unknown]);
    expect(results.size).toBe(1);
    expect(results.has(known.printingHash)).toBe(true);
  });
});
