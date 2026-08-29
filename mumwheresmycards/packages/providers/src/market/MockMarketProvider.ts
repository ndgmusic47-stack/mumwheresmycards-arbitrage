import type { CardPrinting } from "@mwmc/core";
import type { MarketDataProvider, MarketSnapshotResult } from "./MarketDataProvider.js";
import { MARKET_FIXTURES } from "../fixtures/market.fixtures.js";

/**
 * Fixture-backed MarketDataProvider. Default provider for local dev and the
 * ONLY provider used by packages/core tests — never touches the network.
 * Deliberately returns `null` for anything not in the fixture set rather
 * than synthesizing data, so tests stay explicit about what they cover.
 */
export class MockMarketProvider implements MarketDataProvider {
  readonly name = "mock";

  async getSnapshot(printing: CardPrinting): Promise<MarketSnapshotResult | null> {
    const fixture = MARKET_FIXTURES.get(printing.printingHash);
    if (!fixture) return null;
    return { cardId: printing.printingHash, sourceProvider: this.name, ...fixture };
  }

  async getSnapshotsBatch(printings: CardPrinting[]): Promise<Map<string, MarketSnapshotResult>> {
    const results = new Map<string, MarketSnapshotResult>();
    for (const printing of printings) {
      const snapshot = await this.getSnapshot(printing);
      if (snapshot) results.set(printing.printingHash, snapshot);
    }
    return results;
  }
}
