import { describe, it, expect, vi } from "vitest";
import { Db } from "@mwmc/db";
import { resolveCardPrinting } from "@mwmc/core";
import { MarketSnapshotCache } from "../src/market/cache.js";
import type { MarketDataProvider, MarketSnapshotResult } from "../src/market/MarketDataProvider.js";
import { FakeD1 } from "./helpers/fakeD1.js";

const printing = resolveCardPrinting({
  game: "pokemon",
  name: "Charizard",
  setName: "Base Set",
  setCode: "BS",
  cardNumber: "4/102",
  year: 1999,
  language: "EN",
  edition: "1st",
  variant: "holo",
  finish: "shadowless",
  rarity: "Holo Rare",
}).printing!;

function makeSnapshot(overrides: Partial<MarketSnapshotResult> = {}): MarketSnapshotResult {
  return {
    cardId: printing.printingHash,
    sourceProvider: "test-provider",
    priceTimestamp: new Date().toISOString(),
    rawMarketPrice: 100,
    rawQsv: 90,
    psa7: 120,
    psa8: 150,
    psa9: 200,
    psa10: 500,
    confidence: 0.8,
    liquidity: "MEDIUM",
    sampleSize: 10,
    outliersExcluded: 0,
    ...overrides,
  };
}

describe("MarketSnapshotCache", () => {
  it("calls the provider and persists a snapshot on a cache miss (empty DB)", async () => {
    const fakeD1 = new FakeD1();
    const db = new Db(fakeD1);
    const snapshot = makeSnapshot();
    const provider: MarketDataProvider = {
      name: "test-provider",
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
    };

    const cache = new MarketSnapshotCache(db, provider, { ttlHours: 12 });
    const result = await cache.getSnapshot(printing);

    expect(provider.getSnapshot).toHaveBeenCalledTimes(1);
    expect(result?.rawMarketPrice).toBe(100);
    expect(fakeD1.marketSnapshots).toHaveLength(1);
    expect(fakeD1.apiUsage).toHaveLength(1);
    expect(fakeD1.apiUsage[0]!.cache_hit).toBe(0);
  });

  it("serves from cache without calling the provider when a fresh snapshot exists", async () => {
    const fakeD1 = new FakeD1();
    fakeD1.marketSnapshots.push({
      id: 1,
      card_id: printing.printingHash,
      source_provider: "test-provider",
      captured_at: new Date().toISOString(), // just captured — well within TTL
      price_timestamp: new Date().toISOString(),
      raw_market_price: 300,
      raw_qsv: 250,
      psa7: null,
      psa8: null,
      psa9: null,
      psa10: null,
      confidence: 0.9,
      liquidity: "HIGH",
      sample_size: 20,
      psa_population_7: null,
      psa_population_8: null,
      psa_population_9: null,
      psa_population_10: null,
      historical_gem_rate: null,
      outliers_excluded: 0,
      raw_payload: null,
    });

    const db = new Db(fakeD1);
    const provider: MarketDataProvider = { name: "test-provider", getSnapshot: vi.fn() };
    const cache = new MarketSnapshotCache(db, provider, { ttlHours: 12 });

    const result = await cache.getSnapshot(printing);

    expect(provider.getSnapshot).not.toHaveBeenCalled();
    expect(result?.rawMarketPrice).toBe(300);
    expect(fakeD1.apiUsage[0]!.cache_hit).toBe(1);
  });

  it("re-fetches from the provider when the cached snapshot is older than the TTL", async () => {
    const staleTimestamp = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(); // 48h old
    const fakeD1 = new FakeD1();
    fakeD1.marketSnapshots.push({
      id: 1,
      card_id: printing.printingHash,
      source_provider: "test-provider",
      captured_at: staleTimestamp,
      price_timestamp: staleTimestamp,
      raw_market_price: 50,
      raw_qsv: 40,
      psa7: null,
      psa8: null,
      psa9: null,
      psa10: null,
      confidence: 0.5,
      liquidity: "LOW",
      sample_size: 2,
      psa_population_7: null,
      psa_population_8: null,
      psa_population_9: null,
      psa_population_10: null,
      historical_gem_rate: null,
      outliers_excluded: 0,
      raw_payload: null,
    });

    const db = new Db(fakeD1);
    const freshSnapshot = makeSnapshot({ rawMarketPrice: 999 });
    const provider: MarketDataProvider = { name: "test-provider", getSnapshot: vi.fn().mockResolvedValue(freshSnapshot) };
    const cache = new MarketSnapshotCache(db, provider, { ttlHours: 12 });

    const result = await cache.getSnapshot(printing);

    expect(provider.getSnapshot).toHaveBeenCalledTimes(1);
    expect(result?.rawMarketPrice).toBe(999);
    expect(fakeD1.marketSnapshots).toHaveLength(2); // stale + new
  });

  it("falls back to the stale cached row if the provider returns nothing new", async () => {
    const staleTimestamp = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString();
    const fakeD1 = new FakeD1();
    fakeD1.marketSnapshots.push({
      id: 1,
      card_id: printing.printingHash,
      source_provider: "test-provider",
      captured_at: staleTimestamp,
      price_timestamp: staleTimestamp,
      raw_market_price: 77,
      raw_qsv: 60,
      psa7: null,
      psa8: null,
      psa9: null,
      psa10: null,
      confidence: 0.5,
      liquidity: "LOW",
      sample_size: 2,
      psa_population_7: null,
      psa_population_8: null,
      psa_population_9: null,
      psa_population_10: null,
      historical_gem_rate: null,
      outliers_excluded: 0,
      raw_payload: null,
    });

    const db = new Db(fakeD1);
    const provider: MarketDataProvider = { name: "test-provider", getSnapshot: vi.fn().mockResolvedValue(null) };
    const cache = new MarketSnapshotCache(db, provider, { ttlHours: 12 });

    const result = await cache.getSnapshot(printing);
    expect(result?.rawMarketPrice).toBe(77);
  });
});
