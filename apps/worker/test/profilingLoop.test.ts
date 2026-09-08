import { describe, it, expect } from "vitest";
import type { Db, CardRow } from "@mwmc/db";
import { RateLimitExceededError } from "@mwmc/providers";
import type { MarketDataProvider, MarketSnapshotCache, MarketSnapshotResult } from "@mwmc/providers";
import { runMarketProfiling } from "../src/scan/marketProfiling.js";
import { loadSettings } from "../src/repo/settingsRepo.js";
import { NOT_PROFILED_MARKER_PREFIX, markCardCheckedWithoutData } from "../src/repo/marketProfilesRepo.js";

/**
 * REGRESSION GUARD for the 2026-09-08 profiling-loop fix — a genuinely
 * expensive live bug, confirmed against the running production app:
 *
 * `selectCardsNeedingProfileRefresh` orders never-profiled cards first, and
 * a card the market provider returned nothing for never got a
 * flip_profiles row, so it stayed "never profiled" and came straight back
 * to the FRONT of the queue on the very next run. With a ~76k-card
 * catalogue the same ~200 empty cards were re-requested from PokeTrace
 * every 30 minutes, forever: thousands of wasted quota calls a day, zero
 * new price snapshots in 24h, ~62k cards never reached at all. On top of
 * that, a RateLimitExceededError was caught per-card and the loop CARRIED
 * ON to the next card, re-hitting the limit ~200 times per run.
 *
 * These tests drive the real runMarketProfiling() against a fake Db that
 * recognises each query by its SQL shape (same approach as this suite's
 * other repo-level tests — no D1, no network), and pin down: the marker
 * row is written for "no data" and "no ref"; the loop stops dead on the
 * first rate limit; the daily provider budget shrinks/skips the run; and
 * the marker's SQL can never overwrite a live eligible profile.
 */

function cardRow(id: string): CardRow {
  return {
    id,
    name: `Card ${id}`,
    set_name: "Base Set",
    set_code: "BS",
    card_number: "4/102",
    year: 1999,
    language: "EN",
    edition: "na",
    variant: "na",
    finish: "holo",
    rarity: null,
    stamp_type: null,
    last_ebay_scanned_at: null,
  } as unknown as CardRow;
}

interface FakeDbOptions {
  cardsDue: CardRow[];
  /** provider_card_id per internal card id; missing => "no external ref". */
  refs: Record<string, string>;
  providerCallsToday?: number;
  cardsAwaitingBefore?: number;
  cardsAwaitingAfter?: number;
}

function fakeDb(opts: FakeDbOptions) {
  const execs: { sql: string; params: unknown[] }[] = [];
  const selectLimits: number[] = [];
  let awaitingCalls = 0;
  const db = {
    exec: async (sql: string, ...params: unknown[]) => {
      execs.push({ sql, params });
      return { success: true };
    },
    queryFirst: async (sql: string, ...params: unknown[]) => {
      if (/FROM api_usage/.test(sql)) return { n: opts.providerCallsToday ?? 0 };
      if (/FROM external_card_refs/.test(sql)) {
        const internalId = params[1] as string;
        const providerId = opts.refs[internalId];
        return providerId ? { id: 1, provider: "fake", internal_card_id: internalId, provider_card_id: providerId, market: "EU" } : null;
      }
      if (/COUNT\(\*\) as n FROM cards c/.test(sql)) {
        awaitingCalls++;
        return { n: awaitingCalls === 1 ? (opts.cardsAwaitingBefore ?? 0) : (opts.cardsAwaitingAfter ?? 0) };
      }
      return null;
    },
    queryAll: async (sql: string, ...params: unknown[]) => {
      if (/FROM settings/.test(sql)) return [];
      if (/SELECT c\.\* FROM cards c/.test(sql)) {
        const limit = params[params.length - 1] as number;
        selectLimits.push(limit);
        return opts.cardsDue.slice(0, limit);
      }
      return [];
    },
  } as unknown as Db;
  return { db, execs, selectLimits };
}

const fakeProvider = { name: "fake" } as unknown as MarketDataProvider;

function fakeCache(behaviour: (providerCardId: string) => Promise<MarketSnapshotResult | null>) {
  const requested: string[] = [];
  const cache = {
    getSnapshot: async (_internalCardId: string, providerCardId: string) => {
      requested.push(providerCardId);
      return behaviour(providerCardId);
    },
  } as unknown as MarketSnapshotCache;
  return { cache, requested };
}

function markerExecs(execs: { sql: string; params: unknown[] }[]) {
  return execs.filter((e) => /INSERT INTO flip_profiles \(card_id, eligible, ineligible_reason, computed_at\)/.test(e.sql));
}

describe("profiling loop — negative caching of empty provider results", () => {
  it("writes a NOT_PROFILED marker when the provider has no data, so the card leaves the front of the queue", async () => {
    const { db, execs } = fakeDb({ cardsDue: [cardRow("c1")], refs: { c1: "p1" } });
    const settings = await loadSettings(db);
    const { cache } = fakeCache(async () => null);

    const result = await runMarketProfiling(db, fakeProvider, cache, settings, 200, 12);

    expect(result.cardsMissingSnapshot).toBe(1);
    expect(result.cardsMarkedNoData).toBe(1);
    expect(result.cardsProfiled).toBe(0);
    const markers = markerExecs(execs);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.params[0]).toBe("c1");
    expect(String(markers[0]!.params[1])).toMatch(new RegExp(`^${NOT_PROFILED_MARKER_PREFIX}`));
    expect(String(markers[0]!.params[1])).toMatch(/no price data/);
    // And crucially: no real profile was fabricated from nothing.
    expect(execs.some((e) => /INSERT INTO grade_profiles/.test(e.sql))).toBe(false);
  });

  it("writes a distinct NOT_PROFILED marker when the card has no provider reference at all", async () => {
    const { db, execs } = fakeDb({ cardsDue: [cardRow("c1")], refs: {} });
    const settings = await loadSettings(db);
    const { cache, requested } = fakeCache(async () => null);

    const result = await runMarketProfiling(db, fakeProvider, cache, settings, 200, 12);

    expect(result.cardsMissingExternalRef).toBe(1);
    expect(result.cardsMarkedNoData).toBe(1);
    expect(requested).toEqual([]); // nothing to ask the provider with — no call made
    const markers = markerExecs(execs);
    expect(markers).toHaveLength(1);
    expect(String(markers[0]!.params[1])).toMatch(/no market-provider card reference/);
  });

  it("reports the backlog before and after so progress is visible", async () => {
    const { db } = fakeDb({ cardsDue: [cardRow("c1")], refs: { c1: "p1" }, cardsAwaitingBefore: 62668, cardsAwaitingAfter: 62468 });
    const settings = await loadSettings(db);
    const { cache } = fakeCache(async () => null);

    const result = await runMarketProfiling(db, fakeProvider, cache, settings, 200, 12);

    expect(result.cardsAwaitingProfileBefore).toBe(62668);
    expect(result.cardsAwaitingProfileAfter).toBe(62468);
  });
});

describe("profiling loop — stops on the first rate limit", () => {
  it("breaks out of the loop, leaves the remaining cards unrequested and unmarked, and says so", async () => {
    const { db, execs } = fakeDb({ cardsDue: [cardRow("c1"), cardRow("c2"), cardRow("c3")], refs: { c1: "p1", c2: "p2", c3: "p3" } });
    const settings = await loadSettings(db);
    const { cache, requested } = fakeCache(async (providerCardId) => {
      if (providerCardId === "p2") throw new RateLimitExceededError(4);
      return null;
    });

    const result = await runMarketProfiling(db, fakeProvider, cache, settings, 200, 12);

    expect(requested).toEqual(["p1", "p2"]); // p3 never asked
    expect(result.stoppedOnRateLimit).toBe(true);
    expect(result.errors.some((e) => /rate limit hit at card c2/.test(e))).toBe(true);
    // c1 was genuinely checked (no data) => marker; c2/c3 were NOT checked => no marker,
    // so they keep their place at the front of the queue for the next run.
    const markedIds = markerExecs(execs).map((e) => e.params[0]);
    expect(markedIds).toEqual(["c1"]);
  });

  it("still treats any other error as per-card and keeps going", async () => {
    const { db } = fakeDb({ cardsDue: [cardRow("c1"), cardRow("c2")], refs: { c1: "p1", c2: "p2" } });
    const settings = await loadSettings(db);
    const { cache, requested } = fakeCache(async (providerCardId) => {
      if (providerCardId === "p1") throw new Error("PokeTrace GET /cards/p1 failed: 500 Internal Server Error");
      return null;
    });

    const result = await runMarketProfiling(db, fakeProvider, cache, settings, 200, 12);

    expect(requested).toEqual(["p1", "p2"]);
    expect(result.stoppedOnRateLimit).toBe(false);
    expect(result.errors.some((e) => /Market profiling failed for card c1/.test(e))).toBe(true);
  });
});

describe("profiling loop — daily provider-call budget", () => {
  it("shrinks the run's card budget to whatever is left of the daily cap", async () => {
    const { db, selectLimits } = fakeDb({ cardsDue: [cardRow("c1")], refs: { c1: "p1" }, providerCallsToday: 4990 });
    const settings = await loadSettings(db); // default cap: 5000/day
    const { cache } = fakeCache(async () => null);

    const result = await runMarketProfiling(db, fakeProvider, cache, settings, 200, 12);

    expect(selectLimits).toEqual([10]);
    expect(result.cardsSkippedForBudget).toBe(190);
    expect(result.providerCallsUsedToday).toBe(4990);
    expect(result.providerDailyBudget).toBe(5000);
    expect(result.errors.some((e) => /only 10 of 200 cards profiled/.test(e))).toBe(true);
  });

  it("skips profiling entirely once the cap is reached — no cards selected, no provider calls", async () => {
    const { db, selectLimits } = fakeDb({ cardsDue: [cardRow("c1")], refs: { c1: "p1" }, providerCallsToday: 5000 });
    const settings = await loadSettings(db);
    const { cache, requested } = fakeCache(async () => null);

    const result = await runMarketProfiling(db, fakeProvider, cache, settings, 200, 12);

    expect(selectLimits).toEqual([]);
    expect(requested).toEqual([]);
    expect(result.cardsConsidered).toBe(0);
    expect(result.cardsSkippedForBudget).toBe(200);
    expect(result.errors.some((e) => /profiling skipped this run/.test(e))).toBe(true);
  });
});

describe("markCardCheckedWithoutData SQL contract", () => {
  it("never overwrites a currently-eligible profile — the ON CONFLICT update is guarded on eligible = 0", async () => {
    const { db, execs } = fakeDb({ cardsDue: [], refs: {} });
    await markCardCheckedWithoutData(db, "c1", "PROVIDER_NO_DATA");
    expect(execs).toHaveLength(1);
    const sql = execs[0]!.sql;
    expect(sql).toMatch(/ON CONFLICT\(card_id\) DO UPDATE SET/);
    expect(sql).toMatch(/WHERE flip_profiles\.eligible = 0/);
    expect(sql).toMatch(/eligible = 0/);
  });
});
