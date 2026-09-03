import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";
import { capitalAllocationRoute } from "../src/routes/capitalAllocation.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec item 28 (deterministic capital
 * allocation) at the HTTP layer. The allocation arithmetic itself is
 * covered exhaustively in packages/core/test/capitalAllocation.test.ts —
 * these tests pin the route's OWN job: input validation, and correctly
 * shaping the live `opportunities` query results into allocateCapital()'s
 * input.
 */
interface FakeOpportunityRow {
  id: string;
  card_id: string;
  strategy: "FLIP" | "GRADE";
  total_acquisition_cost: number;
  profit_per_capital_day: number | null;
}

function fakeD1(rows: FakeOpportunityRow[]): D1Like {
  const stmt: D1PreparedStatementLike = {
    bind: () => stmt,
    first: async () => null,
    all: async () => ({ results: rows, success: true, meta: {} }) as D1ResultLike<unknown>,
    run: async () => ({ success: true, meta: {} }) as D1ResultLike<unknown>,
  };
  return {
    prepare: () => stmt,
    batch: async () => [],
  };
}

describe("POST /capital-allocation", () => {
  it("allocates across the live qualified-opportunity candidates it queries", async () => {
    const res = await capitalAllocationRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalAvailableCapital: 200, maxSingleOpportunityFraction: 1, maxPerCardFraction: 1 }),
      },
      {
        DB: fakeD1([
          { id: "opp-1", card_id: "card-1", strategy: "FLIP", total_acquisition_cost: 100, profit_per_capital_day: 5 },
          { id: "opp-2", card_id: "card-2", strategy: "GRADE", total_acquisition_cost: 100, profit_per_capital_day: 1 },
          { id: "opp-3", card_id: "card-3", strategy: "FLIP", total_acquisition_cost: 100, profit_per_capital_day: 3 },
        ]),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidatesConsidered: number; accepted: { id: string }[]; capitalAllocated: number };
    expect(body.candidatesConsidered).toBe(3);
    // Budget 200 covers the two most efficient (opp-1 @5, opp-3 @3 = 200),
    // opp-2 (@1) is left out.
    expect(body.accepted.map((d) => d.id)).toEqual(["opp-1", "opp-3"]);
    expect(body.capitalAllocated).toBe(200);
  });

  it("rejects a request with no totalAvailableCapital", async () => {
    const res = await capitalAllocationRoute.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      { DB: fakeD1([]) },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/totalAvailableCapital/);
  });

  it("rejects a non-positive totalAvailableCapital", async () => {
    const res = await capitalAllocationRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalAvailableCapital: -10 }),
      },
      { DB: fakeD1([]) },
    );

    expect(res.status).toBe(400);
  });

  it("handles zero qualified candidates without error", async () => {
    const res = await capitalAllocationRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalAvailableCapital: 500 }),
      },
      { DB: fakeD1([]) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidatesConsidered: number; accepted: unknown[] };
    expect(body.candidatesConsidered).toBe(0);
    expect(body.accepted).toEqual([]);
  });
});
