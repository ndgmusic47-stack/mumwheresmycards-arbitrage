import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import { QUALIFIED_STATES } from "@mwmc/core";
import { loadMarketSummaryStats } from "../src/repo/marketProfilesRepo.js";

/**
 * REGRESSION GUARD for the dashboard's "Live opportunities clearing filters"
 * KPI silently always reading 0.
 *
 * The 2026-08-31 opportunity-states rebuild renamed the qualifying states to
 * QUALIFIED_FLIP / QUALIFIED_GRADE / INSPECT_PHOTOS (see
 * packages/core/src/opportunity/states.ts), but loadMarketSummaryStats kept
 * querying `state IN ('HIGH_CONFIDENCE_FLIP', 'GRADE_CANDIDATE')` — state
 * names that no longer exist anywhere in the schema. No test caught it
 * because nothing asserted the query's literal SQL text against the current
 * state list; a real scan on 2026-09-02 persisted 304 opportunities and the
 * dashboard still reported "0 live opportunities clearing filters", which is
 * what surfaced this. Fixed by building the IN clause from QUALIFIED_STATES
 * directly so the two can never drift apart again.
 */
function capturingDb(counts: Record<string, number> = {}): { db: Db; queries: string[] } {
  const queries: string[] = [];
  const db = {
    exec: async () => ({ success: true }),
    queryFirst: async (sql: string) => {
      queries.push(sql);
      for (const [pattern, n] of Object.entries(counts)) {
        if (sql.includes(pattern)) return { n };
      }
      return { n: 0 };
    },
    queryAll: async () => [],
  } as unknown as Db;
  return { db, queries };
}

describe("loadMarketSummaryStats — live opportunity count", () => {
  it("queries opportunities.state using every current QUALIFIED_STATES value", async () => {
    const { db, queries } = capturingDb();
    await loadMarketSummaryStats(db);

    const opportunitiesQuery = queries.find((q) => q.includes("FROM opportunities"));
    expect(opportunitiesQuery).toBeDefined();
    for (const state of QUALIFIED_STATES) {
      expect(opportunitiesQuery).toContain(`'${state}'`);
    }
  });

  it("never references the old, now-nonexistent state names", async () => {
    const { db, queries } = capturingDb();
    await loadMarketSummaryStats(db);

    const opportunitiesQuery = queries.find((q) => q.includes("FROM opportunities"))!;
    expect(opportunitiesQuery).not.toMatch(/HIGH_CONFIDENCE_FLIP|GRADE_CANDIDATE/);
  });

  it("actually counts qualifying rows end to end, not just zero", async () => {
    const { db } = capturingDb({ "FROM opportunities": 7 });
    const summary = await loadMarketSummaryStats(db);

    expect(summary.liveOpportunities).toBe(7);
  });

  it("reports cardsProfiled from the union of flip_profiles and grade_profiles, not from market_snapshots", async () => {
    // STABILISATION item 2: cardsProfiled ("we computed economics for this
    // card") is a distinct number from cardsWithMarketData ("we have a
    // price snapshot") — a card can have a snapshot but fail profiling, or
    // vice versa never reach profiling if its snapshot was too thin. Assert
    // the query is a UNION over both profile tables, not accidentally
    // aliased onto the market_snapshots count.
    const { db, queries } = capturingDb();
    await loadMarketSummaryStats(db);

    const profiledQuery = queries.find((q) => q.includes("flip_profiles") && q.includes("grade_profiles"));
    expect(profiledQuery).toBeDefined();
    expect(profiledQuery).toMatch(/UNION/);
  });
});
