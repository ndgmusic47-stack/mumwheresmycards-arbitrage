import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";
import { maxBuyRoute } from "../src/routes/maxBuy.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec item 14 (GRADE reverse max-buy
 * solver) at the HTTP layer. The arithmetic itself is covered exhaustively
 * in packages/core/test/maxBuySolver.test.ts (including round-trip proofs)
 * — these tests pin the route's OWN job: input validation, resolving a
 * grading service by id from live Settings (never hardcoded), and rejecting
 * an unknown service rather than silently falling back to one.
 *
 * An empty `settings` table is a legitimate, well-defined case — every
 * settingsRepo.ts field falls back to its documented default (see
 * settingsRepo.ts), which for gradingServices is DEFAULT_GRADING_SERVICES
 * (PSA_REGULAR, PSA_VALUE). This fake D1 always returns no rows, so these
 * tests exercise exactly that default path.
 */
function emptyD1(): D1Like {
  const emptyResult: D1ResultLike<unknown> = { results: [], success: true, meta: {} };
  const stmt: D1PreparedStatementLike = {
    bind: () => stmt,
    first: async () => null,
    all: async () => emptyResult,
    run: async () => emptyResult,
  };
  return {
    prepare: () => stmt,
    batch: async () => [],
  };
}

describe("POST /max-buy/grade", () => {
  it("solves against a known grading service id (PSA_VALUE, the default settings fallback)", async () => {
    const res = await maxBuyRoute.request(
      "/grade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slabValueAtGrade: 600,
          serviceId: "PSA_VALUE",
          minNetProfit: 40,
          minReturnOnCapital: 0.4,
        }),
      },
      { DB: emptyD1() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.serviceId).toBe("PSA_VALUE");
    expect(body.maxRawPurchasePrice).toBeGreaterThan(0);
    expect(body.bindingConstraint).toBe("ROC");
  });

  it("rejects an unknown serviceId rather than silently substituting a default", async () => {
    const res = await maxBuyRoute.request(
      "/grade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slabValueAtGrade: 600,
          serviceId: "NOT_A_REAL_SERVICE",
          minNetProfit: 40,
          minReturnOnCapital: 0.4,
        }),
      },
      { DB: emptyD1() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown serviceId/);
  });

  it("rejects a request missing required numeric fields", async () => {
    const res = await maxBuyRoute.request(
      "/grade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId: "PSA_VALUE" }),
      },
      { DB: emptyD1() },
    );

    expect(res.status).toBe(400);
  });

  it("rejects a request missing serviceId", async () => {
    const res = await maxBuyRoute.request(
      "/grade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slabValueAtGrade: 600, minNetProfit: 40, minReturnOnCapital: 0.4 }),
      },
      { DB: emptyD1() },
    );

    expect(res.status).toBe(400);
  });

  it("defaults the returned grade to the shared reference-grade convention when not supplied", async () => {
    const res = await maxBuyRoute.request(
      "/grade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slabValueAtGrade: 600,
          serviceId: "PSA_REGULAR",
          minNetProfit: 40,
          minReturnOnCapital: 0.4,
        }),
      },
      { DB: emptyD1() },
    );

    const body = (await res.json()) as { grade: number };
    expect(body.grade).toBe(9);
  });
});
