import { describe, it, expect } from "vitest";
import { Db, MAX_SQL_IN_CLAUSE_SIZE } from "@mwmc/db";
import { QUALIFIED_STATES } from "@mwmc/core";
import { listOpportunitiesForAiReview, applyAiCandidateReview } from "../src/repo/opportunitiesRepo.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE gap 3 (selective AI review in the
 * candidate pipeline).
 *
 * Two contracts matter most here:
 * (1) listOpportunitiesForAiReview only ever asks for QUALIFIED_STATES
 *     candidates never AI-reviewed before (ai_review_status IS NULL), and
 *     never builds an unbounded IN (...) clause for a large listing-id set
 *     (same class of bug fixed in listingsRepo.ts's getAlreadyEnrichedListingIds
 *     — see sqlChunk.ts).
 * (2) applyAiCandidateReview is structurally incapable of writing anything
 *     beyond the four ai_review_* / ai_reviewed_at columns — it must never
 *     appear capable of touching `state`, `qualifies`, or any economics
 *     column, regardless of what's passed in.
 */
describe("listOpportunitiesForAiReview", () => {
  it("returns an empty array without querying when given no listing ids", async () => {
    let queried = false;
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async () => {
        queried = true;
        return [];
      },
    } as unknown as Db;

    const result = await listOpportunitiesForAiReview(db, []);
    expect(result).toEqual([]);
    expect(queried).toBe(false);
  });

  it("filters to QUALIFIED_STATES and ai_review_status IS NULL, binding the listing ids and every qualified state", async () => {
    let capturedSql = "";
    let capturedArgs: unknown[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string, ...args: unknown[]) => {
        capturedSql = sql;
        capturedArgs = args;
        return [{ id: "opp-1", listing_id: "L1", card_name: "Charizard ex", state: "QUALIFIED_FLIP" }];
      },
    } as unknown as Db;

    const result = await listOpportunitiesForAiReview(db, ["L1", "L2"]);

    expect(capturedSql).toMatch(/o\.state IN \(\?,\?,\?\)/);
    expect(capturedSql).toMatch(/o\.ai_review_status IS NULL/);
    expect(capturedSql).toMatch(/JOIN cards c ON c\.id = o\.card_id/);
    // listing ids first, then every QUALIFIED_STATES value, in order —
    // must match placeholder order in the SQL exactly or D1 mis-binds.
    expect(capturedArgs).toEqual(["L1", "L2", ...QUALIFIED_STATES]);
    expect(result).toHaveLength(1);
    expect(result[0]!.card_name).toBe("Charizard ex");
  });

  it("splits a large listing-id list into multiple bounded queries and merges every batch's results", async () => {
    const manyIds = Array.from({ length: 250 }, (_, i) => `L${i}`);
    const queryCalls: { sql: string; args: unknown[] }[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string, ...args: unknown[]) => {
        queryCalls.push({ sql, args });
        return [{ id: `opp-${queryCalls.length}`, listing_id: args[0] as string, card_name: "X" }];
      },
    } as unknown as Db;

    const result = await listOpportunitiesForAiReview(db, manyIds);

    expect(queryCalls.length).toBeGreaterThan(1);
    for (const call of queryCalls) {
      // Each call's args = one chunk of listing ids + the fixed QUALIFIED_STATES
      // tail — never the full 250-id list in one statement.
      expect(call.args.length).toBeLessThan(manyIds.length + QUALIFIED_STATES.length);
    }
    expect(result.length).toBe(queryCalls.length);
  });

  // BUG FIX regression (found live 2026-09-03): a chunk of exactly
  // MAX_SQL_IN_CLAUSE_SIZE listing ids PLUS the QUALIFIED_STATES tail used
  // to total MAX_SQL_IN_CLAUSE_SIZE + QUALIFIED_STATES.length bound params
  // in a single statement — over D1's real per-statement ceiling, and it
  // failed live with "D1_ERROR: too many SQL variables" on a real scan run
  // once enough candidates qualified in one pass. Every call's TOTAL bound
  // params (chunk + QUALIFIED_STATES) must never exceed MAX_SQL_IN_CLAUSE_SIZE.
  it("never binds more than MAX_SQL_IN_CLAUSE_SIZE total params in one statement, even with a full-size chunk plus the QUALIFIED_STATES tail", async () => {
    const manyIds = Array.from({ length: MAX_SQL_IN_CLAUSE_SIZE + 10 }, (_, i) => `L${i}`);
    const queryCalls: { args: unknown[] }[] = [];
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (_sql: string, ...args: unknown[]) => {
        queryCalls.push({ args });
        return [];
      },
    } as unknown as Db;

    await listOpportunitiesForAiReview(db, manyIds);

    expect(queryCalls.length).toBeGreaterThan(1);
    for (const call of queryCalls) {
      expect(call.args.length).toBeLessThanOrEqual(MAX_SQL_IN_CLAUSE_SIZE);
    }
  });
});

describe("applyAiCandidateReview", () => {
  it("writes exactly the four ai_review_*/ai_reviewed_at columns, keyed by opportunity id — nothing else", async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const db = {
      exec: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        return { success: true };
      },
      queryFirst: async () => null,
      queryAll: async () => [],
    } as unknown as Db;

    await applyAiCandidateReview(db, "opp-1", { route: "REVIEW", confidence: 0.62, reason: "Some evidence." });

    expect(calls).toHaveLength(1);
    const { sql, args } = calls[0]!;
    expect(sql).toMatch(/UPDATE opportunities SET/);
    expect(sql).toMatch(/ai_review_status = \?/);
    expect(sql).toMatch(/ai_review_reason = \?/);
    expect(sql).toMatch(/ai_review_confidence = \?/);
    expect(sql).toMatch(/ai_reviewed_at = datetime\('now'\)/);
    expect(sql).toMatch(/WHERE id = \?/);

    // Structurally incapable of touching state/qualifies/economics — this
    // function's SQL text must never mention them, regardless of input.
    expect(sql).not.toMatch(/\bstate\s*=/);
    expect(sql).not.toMatch(/qualifies/);
    expect(sql).not.toMatch(/qsv/i);
    expect(sql).not.toMatch(/expected_net_profit/);
    expect(sql).not.toMatch(/total_acquisition_cost/);

    expect(args).toEqual(["REVIEW", "Some evidence.", 0.62, "opp-1"]);
  });

  it("stores a null confidence/reason exactly as given, never a fabricated default", async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const db = {
      exec: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        return { success: true };
      },
      queryFirst: async () => null,
      queryAll: async () => [],
    } as unknown as Db;

    await applyAiCandidateReview(db, "opp-2", { route: "BLOCK_FROM_ACTIONABLE", confidence: null, reason: null });

    expect(calls[0]!.args).toEqual(["BLOCK_FROM_ACTIONABLE", null, null, "opp-2"]);
  });

  it("accepts every CandidateRoute value", async () => {
    const routes = ["PASS_THROUGH", "REVIEW", "BLOCK_FROM_ACTIONABLE"] as const;
    for (const route of routes) {
      const calls: { sql: string; args: unknown[] }[] = [];
      const db = {
        exec: async (sql: string, ...args: unknown[]) => {
          calls.push({ sql, args });
          return { success: true };
        },
        queryFirst: async () => null,
        queryAll: async () => [],
      } as unknown as Db;

      await applyAiCandidateReview(db, "opp-3", { route, confidence: 0.5, reason: "r" });
      expect(calls[0]!.args[0]).toBe(route);
    }
  });
});
