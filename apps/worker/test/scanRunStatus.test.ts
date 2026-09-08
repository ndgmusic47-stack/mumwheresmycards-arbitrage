import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";
import { runScan } from "../src/scan/scanRunner.js";
import type { Env } from "../src/env.js";

/**
 * REGRESSION GUARD for two scan-status fixes shipped 2026-09-08:
 *
 * 1. PARTIAL noise — informational messages ("N listings resolved to an
 *    uncatalogued card, this is expected", the abandoned-run sweep note,
 *    etc.) used to be pushed into the same `errors` array that decided the
 *    run's status, so nearly every healthy scan read PARTIAL and the status
 *    stopped meaning anything. Now only genuine failures decide status;
 *    notes are still persisted and shown.
 * 2. Zombie RUNNING rows — a run killed mid-flight (live cause: the
 *    Cloudflare per-invocation subrequest cap, which also killed the catch
 *    block's own FAILED update) stayed RUNNING forever. Each run now sweeps
 *    rows still RUNNING 120+ minutes after starting to FAILED first.
 *
 * Runs the REAL runScan() end to end against the mock providers and a fake
 * D1 that answers every query with "empty" except the ones under test —
 * same fake-D1 approach as queryInterpreterRoute.test.ts, so this stays a
 * unit test of the run's bookkeeping, not a Miniflare integration test.
 */

function fakeD1(zombieIds: string[]) {
  const execs: { sql: string; params: unknown[] }[] = [];
  const d1: D1Like = {
    prepare: (sql: string): D1PreparedStatementLike => {
      let params: unknown[] = [];
      const self: D1PreparedStatementLike = {
        bind: (...args: unknown[]) => {
          params = args;
          return self;
        },
        first: async <T>() => {
          if (/COUNT\(\*\) as n/.test(sql)) return { n: 0 } as unknown as T;
          // runCatalogueSyncJob reads its own run row back at the end — with
          // the mock catalogue provider and an empty fake DB that's a clean
          // (non-FAILED) sync, which is what we want here: this test is about
          // the SCAN's status, not the sync's.
          if (/FROM catalogue_sync_runs WHERE id = \?/.test(sql)) return { id: params[0], status: "SUCCESS", errors: null } as unknown as T;
          if (/SELECT \* FROM scan_runs WHERE id = \?/.test(sql)) {
            // The final row read-back — echo the status the last UPDATE wrote.
            const lastUpdate = [...execs].reverse().find((e) => /UPDATE scan_runs SET\s+status = \?/.test(e.sql));
            return {
              id: params[0],
              status: lastUpdate ? lastUpdate.params[0] : "RUNNING",
              errors: lastUpdate ? lastUpdate.params[lastUpdate.params.length - 2] : null,
            } as unknown as T;
          }
          return null as T | null;
        },
        all: async <T>() => {
          if (/FROM scan_runs WHERE status = 'RUNNING'/.test(sql)) {
            return { results: zombieIds.map((id) => ({ id })) as unknown as T[], success: true, meta: {} } as D1ResultLike<T>;
          }
          return { results: [] as T[], success: true, meta: {} } as D1ResultLike<T>;
        },
        run: async () => {
          execs.push({ sql, params });
          return { success: true, meta: {} };
        },
      };
      return self;
    },
    batch: async <T>() => [] as D1ResultLike<T>[],
  };
  return { d1, execs };
}

function fakeEnv(d1: D1Like): Env {
  return {
    DB: d1 as unknown as D1Database,
    ENVIRONMENT: "development",
    CF_ACCESS_TEAM_DOMAIN: "unused",
    MARKET_PROVIDER: "mock",
    EBAY_PROVIDER: "mock",
    DEFAULT_LISTING_REFRESH_MINUTES: "30",
    DEFAULT_MARKET_REFRESH_HOURS: "12",
  } as unknown as Env;
}

describe("runScan status bookkeeping", () => {
  it("sweeps abandoned RUNNING runs to FAILED before starting, and that note does NOT make the new run PARTIAL", async () => {
    const { d1, execs } = fakeD1(["zombie-1", "zombie-2"]);

    const result = await runScan(fakeEnv(d1), "MANUAL");

    // 1. The sweep happened, once per zombie, guarded on status = 'RUNNING'.
    const sweeps = execs.filter((e) => /SET status = 'FAILED'.*WHERE id = \? AND status = 'RUNNING'/.test(e.sql));
    expect(sweeps.map((e) => e.params[1])).toEqual(["zombie-1", "zombie-2"]);
    expect(String(sweeps[0]!.params[0])).toMatch(/Abandoned/);
    expect(result.abandonedRunsRecovered).toBe(2);

    // 2. The sweep note is persisted with the run (so it's visible)...
    const finalUpdate = execs.find((e) => /UPDATE scan_runs SET\s+status = \?/.test(e.sql))!;
    const persisted = JSON.parse(String(finalUpdate.params[finalUpdate.params.length - 2])) as string[];
    expect(persisted.some((m) => /2 earlier scan run\(s\).*marked FAILED/.test(m))).toBe(true);

    // 3. ...but the run's own status is still SUCCESS — a note is not an error.
    expect(finalUpdate.params[0]).toBe("SUCCESS");
    expect(result.scanRun.status).toBe("SUCCESS");
  });

  it("with nothing to sweep and nothing to note, persists a clean SUCCESS with no messages at all", async () => {
    const { d1, execs } = fakeD1([]);

    const result = await runScan(fakeEnv(d1), "CRON");

    expect(result.abandonedRunsRecovered).toBe(0);
    const finalUpdate = execs.find((e) => /UPDATE scan_runs SET\s+status = \?/.test(e.sql))!;
    expect(finalUpdate.params[0]).toBe("SUCCESS");
    expect(finalUpdate.params[finalUpdate.params.length - 2]).toBeNull();
  });
});
