import type { MarketDataProvider, MarketSnapshotResult } from "./MarketDataProvider.js";
import { MARKET_FIXTURES_BY_PROVIDER_ID } from "../fixtures/market.fixtures.js";

/**
 * Fixture-backed MarketDataProvider, keyed by PROVIDER card ID (matching
 * the real PokeTrace contract's lookup key) — the ONLY provider used by
 * packages/core tests and local dev, never touches the network.
 * Deliberately returns `null` for anything not in the fixture set rather
 * than synthesizing data, so tests stay explicit about what they cover.
 */
export class MockMarketProvider implements MarketDataProvider {
  readonly name = "mock";

  async getSnapshotByProviderId(providerCardId: string): Promise<MarketSnapshotResult | null> {
    const fixture = MARKET_FIXTURES_BY_PROVIDER_ID.get(providerCardId);
    if (!fixture) return null;
    return { providerCardId, sourceProvider: this.name, ...fixture };
  }

  async getSnapshotsBatch(providerCardIds: string[]): Promise<Map<string, MarketSnapshotResult>> {
    const results = new Map<string, MarketSnapshotResult>();
    for (const id of providerCardIds) {
      const snapshot = await this.getSnapshotByProviderId(id);
      if (snapshot) results.set(id, snapshot);
    }
    return results;
  }
}
