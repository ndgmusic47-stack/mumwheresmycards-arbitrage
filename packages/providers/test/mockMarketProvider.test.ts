import { describe, it, expect } from "vitest";
import { MockMarketProvider } from "../src/market/MockMarketProvider.js";
import { MARKET_FIXTURES } from "../src/fixtures/market.fixtures.js";

describe("MockMarketProvider", () => {
  it("returns a snapshot for a fixture provider card id", async () => {
    const provider = new MockMarketProvider();
    const fixture = MARKET_FIXTURES[0]!;
    const snapshot = await provider.getSnapshotByProviderId(fixture.providerCardId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.providerCardId).toBe(fixture.providerCardId);
    expect(snapshot!.sourceProvider).toBe("mock");
  });

  it("returns null for a provider card id with no fixture (never synthesizes data)", async () => {
    const provider = new MockMarketProvider();
    expect(await provider.getSnapshotByProviderId("totally-unknown-id")).toBeNull();
  });

  it("getSnapshotsBatch resolves multiple provider card ids and skips missing ones", async () => {
    const provider = new MockMarketProvider();
    const known = MARKET_FIXTURES[0]!.providerCardId;
    const results = await provider.getSnapshotsBatch!([known, "unknown-id"]);
    expect(results.size).toBe(1);
    expect(results.has(known)).toBe(true);
  });
});
