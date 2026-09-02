import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import { loadScanCoverageStats } from "../src/repo/marketProfilesRepo.js";

/**
 * REGRESSION GUARD for STABILISATION item 3 (coverage/scanning
 * transparency). Pins down loadScanCoverageStats's contract: it must query
 * the eligible (flip- or grade-eligible) universe, join against
 * cards.last_ebay_scanned_at, and pass the STALENESS_CAP_HOURS window
 * through as a bound parameter (not a hardcoded literal baked separately
 * from packages/core's own staleness cap, which would let the two drift
 * apart the way bug 8's hardcoded state list did).
 */
function fakeDb(row: Record<string, unknown> | null): { db: Db; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    exec: async () => ({ success: true }),
    queryFirst: async (sql: string, ...params: unknown[]) => {
      queries.push({ sql, params });
      return row;
    },
    queryAll: async () => [],
  } as unknown as Db;
  return { db, queries };
}

describe("loadScanCoverageStats", () => {
  it("queries the flip/grade eligible universe joined against cards.last_ebay_scanned_at", async () => {
    const { db, queries } = fakeDb({ eligibleUniverseSize: 0, neverSearched: 0, searchedRecently: 0, oldestSearchedAgeHours: null });
    await loadScanCoverageStats(db);

    expect(queries).toHaveLength(1);
    const sql = queries[0]!.sql;
    expect(sql).toMatch(/flip_profiles/);
    expect(sql).toMatch(/grade_profiles/);
    expect(sql).toMatch(/eligible = 1/);
    expect(sql).toMatch(/last_ebay_scanned_at/);
    // 168 hours (one week) must be a bound parameter, not hand-duplicated
    // as a separate literal from packages/core's STALENESS_CAP_HOURS.
    expect(queries[0]!.params).toContain(168);
  });

  it("passes through real counts end to end", async () => {
    const { db } = fakeDb({ eligibleUniverseSize: 662, neverSearched: 401, searchedRecently: 150, oldestSearchedAgeHours: 842.5 });
    const stats = await loadScanCoverageStats(db);

    expect(stats).toEqual({
      eligibleUniverseSize: 662,
      neverSearched: 401,
      searchedRecently: 150,
      oldestSearchedAgeHours: 842.5,
    });
  });

  it("defaults every field safely when the query returns no row", async () => {
    const { db } = fakeDb(null);
    const stats = await loadScanCoverageStats(db);

    expect(stats).toEqual({
      eligibleUniverseSize: 0,
      neverSearched: 0,
      searchedRecently: 0,
      oldestSearchedAgeHours: null,
    });
  });
});
