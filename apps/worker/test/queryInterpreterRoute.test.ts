import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";
import { queryInterpreterRoute } from "../src/routes/queryInterpreter.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream L
 * (natural-language query interpreter) at the HTTP layer. The actual
 * interpretation/sanitization logic is covered exhaustively in
 * packages/providers/test/aiQueryInterpreterProvider.test.ts — these tests
 * pin the route's OWN job: input validation, and that the full real chain
 * (settings load -> createAiModelProvider -> AiCompletionCache ->
 * GuardedAiModelProvider -> AiQueryInterpreterProvider) wires together and
 * degrades honestly with no OPENAI_API_KEY bound (the only case this test
 * environment can exercise without a real key), same as every other AI
 * route in this app.
 */

/** Minimal in-memory D1 double — `.all()` always empty (settings load
 *  resolves to defaults, same as an unconfigured environment), `.first()`
 *  returns null for a cache lookup and {total: 0} for a spend-cap sum
 *  query, `.run()` is a no-op success. Same "recognize by SQL prefix"
 *  approach as AiCompletionCache's own test double. */
function fakeD1(): D1Like {
  const stmt: D1PreparedStatementLike = {
    bind: () => stmt,
    first: async <T>() => null as T | null,
    all: async <T>() => ({ results: [] as T[], success: true, meta: {} }) as D1ResultLike<T>,
    run: async <T>() => ({ success: true, meta: {} }) as D1ResultLike<T>,
  };
  const d1: D1Like = {
    prepare: (sql: string): D1PreparedStatementLike => {
      let params: unknown[] = [];
      const self: D1PreparedStatementLike = {
        bind: (...args: unknown[]) => {
          params = args;
          return self;
        },
        first: async <T>() => {
          if (/SUM\(cost_weight\)/i.test(sql)) return { total: 0 } as unknown as T;
          return null as T | null;
        },
        all: async <T>() => ({ results: [] as T[], success: true, meta: {} }) as D1ResultLike<T>,
        run: async <T>() => ({ success: true, meta: {} }) as D1ResultLike<T>,
      };
      void params;
      return self;
    },
    batch: async () => [],
  };
  void stmt;
  return d1;
}

describe("POST /query-interpret", () => {
  it("rejects a missing queryText", async () => {
    const res = await queryInterpreterRoute.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      { DB: fakeD1() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/queryText/);
  });

  it("rejects an empty/whitespace-only queryText", async () => {
    const res = await queryInterpreterRoute.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queryText: "   " }) },
      { DB: fakeD1() },
    );

    expect(res.status).toBe(400);
  });

  it("rejects a queryText over the length ceiling", async () => {
    const res = await queryInterpreterRoute.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queryText: "a".repeat(501) }) },
      { DB: fakeD1() },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/500 characters/);
  });

  it("wires the full chain together and degrades honestly with no OPENAI_API_KEY bound", async () => {
    const res = await queryInterpreterRoute.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queryText: "grade opportunities under £100" }) },
      { DB: fakeD1() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { interpretation: { available: boolean; filters: unknown; caveats: string[] }; providerName: string };
    expect(body.providerName).toBe("query-interpreter");
    expect(body.interpretation.available).toBe(false);
    expect(body.interpretation.filters).toBeNull();
    expect(body.interpretation.caveats[0]).toMatch(/not configured|API key/i);
  });
});
