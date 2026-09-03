import { describe, it, expect } from "vitest";
import { Db, type MarketSnapshotRow } from "@mwmc/db";
import { hydrateStoredSnapshots } from "../src/scan/marketProfiling.js";

/**
 * REGRESSION GUARD for STABILISATION item 4 (false NO_MARKET_DATA).
 *
 * Root cause: runMarketProfiling()'s snapshotByCardId only covers cards
 * profiled THIS run (budget-capped), but the eBay-search step draws from
 * the full eligible universe — a card searched this run but not profiled
 * this run got no snapshot entry even when D1 already held a perfectly
 * valid one from an earlier run. hydrateStoredSnapshots() is the fallback
 * that closes this gap; these tests pin down its contract directly against
 * a fake Db, without needing real D1.
 */
function snapshotRow(overrides: Partial<MarketSnapshotRow> = {}): MarketSnapshotRow {
  return {
    id: 1,
    card_id: "card-1",
    source_provider: "poketrace",
    captured_at: "2026-08-30T00:00:00Z",
    price_timestamp: "2026-08-30T00:00:00Z",
    raw_market_price: 42,
    raw_median_7d: 40,
    raw_median_30d: 44,
    raw_qsv: 38,
    qsv_basis: "sold_median",
    is_high_confidence_qsv: 1,
    psa6: null,
    psa7: 80,
    psa8: 120,
    psa9: 250,
    psa10: 900,
    confidence: 0.8,
    liquidity: "MEDIUM",
    sample_size: 12,
    psa_population_7: null,
    psa_population_8: null,
    psa_population_9: null,
    psa_population_10: null,
    historical_gem_rate: null,
    outliers_excluded: 0,
    raw_payload: null,
    created_at: "2026-08-30T00:00:00Z",
    ...overrides,
  } as MarketSnapshotRow;
}

function fakeDb(rows: MarketSnapshotRow[]): { db: Db; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    exec: async () => ({ success: true }),
    queryFirst: async () => null,
    queryAll: async (sql: string, ...params: unknown[]) => {
      queries.push({ sql, params });
      return rows;
    },
  } as unknown as Db;
  return { db, queries };
}

describe("hydrateStoredSnapshots", () => {
  it("returns an empty map and runs no query for an empty card id list", async () => {
    const { db, queries } = fakeDb([]);
    const result = await hydrateStoredSnapshots(db, []);
    expect(result.size).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("queries market_snapshots for the latest row per requested card id", async () => {
    const { db, queries } = fakeDb([snapshotRow()]);
    await hydrateStoredSnapshots(db, ["card-1", "card-2"]);

    expect(queries).toHaveLength(1);
    const { sql, params } = queries[0]!;
    expect(sql).toMatch(/FROM market_snapshots/);
    expect(sql).toMatch(/MAX\(ms2\.captured_at\)/);
    expect(params).toEqual(["card-1", "card-2"]);
  });

  it("maps a valid stored row into a MarketSnapshotLike keyed by card_id", async () => {
    const { db } = fakeDb([snapshotRow({ card_id: "card-1", raw_market_price: 55, psa10: 999 })]);
    const result = await hydrateStoredSnapshots(db, ["card-1"]);

    expect(result.has("card-1")).toBe(true);
    const snapshot = result.get("card-1")!;
    expect(snapshot.rawMarketPrice).toBe(55);
    expect(snapshot.psa10).toBe(999);
    expect(snapshot.sourceProvider).toBe("poketrace");
  });

  it("does NOT resurrect a stored row where every price field is null", async () => {
    const { db } = fakeDb([
      snapshotRow({ card_id: "card-empty", raw_market_price: null, psa7: null, psa8: null, psa9: null, psa10: null }),
    ]);
    const result = await hydrateStoredSnapshots(db, ["card-empty"]);
    expect(result.has("card-empty")).toBe(false);
  });

  it("keeps a row with only a PSA value populated (raw price null) — grade-only data is still valid", async () => {
    const { db } = fakeDb([snapshotRow({ card_id: "card-grade-only", raw_market_price: null, psa10: 500 })]);
    const result = await hydrateStoredSnapshots(db, ["card-grade-only"]);
    expect(result.has("card-grade-only")).toBe(true);
  });

  /**
   * REGRESSION GUARD, 2026-09-03: same unbounded-IN-clause bug class as
   * listingsRepo.ts's getAlreadyEnrichedListingIds — a universe-wide scan
   * can easily pass more card ids than one D1 statement can bind. Proves
   * this now issues multiple bounded queries and merges every batch's rows.
   */
  it("splits a large card id list into multiple bounded queries and merges every batch's rows", async () => {
    const manyIds = Array.from({ length: 250 }, (_, i) => `card-${i}`);
    const queries: { sql: string; params: unknown[] }[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string, ...params: unknown[]) => {
        queries.push({ sql, params });
        return (params as string[]).map((cardId) => snapshotRow({ card_id: cardId, raw_market_price: 10 }));
      },
    } as unknown as Db;

    const result = await hydrateStoredSnapshots(db, manyIds);

    expect(queries.length).toBeGreaterThan(1);
    for (const q of queries) {
      expect(q.params.length).toBeLessThan(manyIds.length);
    }
    const allQueriedIds = queries.flatMap((q) => q.params as string[]);
    expect(new Set(allQueriedIds)).toEqual(new Set(manyIds));
    expect(result.size).toBe(manyIds.length);
  });
});
