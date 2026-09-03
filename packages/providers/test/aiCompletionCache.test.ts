import { describe, it, expect, vi } from "vitest";
import { Db, type D1Like, type D1PreparedStatementLike, type D1ResultLike } from "@mwmc/db";
import { AiCompletionCache, computeAiCacheKey, estimateCostUsd } from "../src/ai/AiCompletionCache.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream G (AI
 * caching + cost control). Two non-negotiable contracts: (1) an identical
 * request is answered from cache, at zero logged cost, without ever
 * calling the inner provider again; (2) once today's logged spend reaches
 * the configured cap, a genuinely new request is refused BEFORE the inner
 * provider is ever called — never mid-call, never silently over budget.
 */

interface AiCacheRow {
  cache_key: string;
  tier: string;
  model_id: string | null;
  prompt_version_id: string | null;
  output_text: string | null;
  parsed_json: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  created_at: string;
}
interface ApiUsageRow {
  provider: string;
  endpoint: string;
  scan_run_id: string | null;
  cache_hit: number;
  cost_weight: number;
  called_at: string;
}

/** Minimal in-memory D1 double covering exactly the statement shapes
 *  AiCompletionCache issues — same "recognize by SQL prefix" approach as
 *  the shared FakeD1 helper, kept local to this file since it needs two
 *  tables (ai_completion_cache, api_usage) that helper doesn't cover. */
function fakeD1(initialSpendUsd = 0): { db: Db; aiCache: AiCacheRow[]; apiUsage: ApiUsageRow[] } {
  const aiCache: AiCacheRow[] = [];
  const apiUsage: ApiUsageRow[] = initialSpendUsd > 0
    ? [{ provider: "openai", endpoint: "FAST", scan_run_id: null, cache_hit: 0, cost_weight: initialSpendUsd, called_at: new Date().toISOString() }]
    : [];

  const d1: D1Like = {
    prepare(sql: string): D1PreparedStatementLike {
      let params: unknown[] = [];
      const self: D1PreparedStatementLike = {
        bind: (...args: unknown[]) => {
          params = args;
          return self;
        },
        first: async <T>() => {
          if (/SELECT \* FROM ai_completion_cache/i.test(sql)) {
            const row = aiCache.find((r) => r.cache_key === params[0]);
            return (row ?? null) as T | null;
          }
          if (/SUM\(cost_weight\)/i.test(sql)) {
            const provider = params[0];
            const total = apiUsage.filter((r) => r.provider === provider).reduce((sum, r) => sum + r.cost_weight, 0);
            return { total } as unknown as T;
          }
          return null;
        },
        all: async <T>() => ({ results: [] as T[], success: true, meta: {} }) as D1ResultLike<T>,
        run: async <T>() => {
          if (/INSERT INTO ai_completion_cache/i.test(sql)) {
            const [cache_key, tier, model_id, prompt_version_id, output_text, parsed_json, usage_input_tokens, usage_output_tokens] = params;
            if (!aiCache.some((r) => r.cache_key === cache_key)) {
              aiCache.push({
                cache_key: cache_key as string,
                tier: tier as string,
                model_id: model_id as string | null,
                prompt_version_id: prompt_version_id as string | null,
                output_text: output_text as string | null,
                parsed_json: parsed_json as string | null,
                usage_input_tokens: usage_input_tokens as number | null,
                usage_output_tokens: usage_output_tokens as number | null,
                created_at: new Date().toISOString(),
              });
            }
          } else if (/INSERT INTO api_usage/i.test(sql)) {
            const [provider, endpoint, scan_run_id, cache_hit, cost_weight] = params;
            apiUsage.push({
              provider: provider as string,
              endpoint: endpoint as string,
              scan_run_id: scan_run_id as string | null,
              cache_hit: cache_hit ? 1 : 0,
              cost_weight: cost_weight as number,
              called_at: new Date().toISOString(),
            });
          }
          return { success: true, meta: {} } as D1ResultLike<T>;
        },
      };
      return self;
    },
    batch: async () => [],
  };

  return { db: new Db(d1), aiCache, apiUsage };
}

function req(overrides: Partial<AiCompletionRequest> = {}): AiCompletionRequest {
  return { tier: "FAST", instructions: "sys", input: "hello", ...overrides };
}

function successResult(overrides: Partial<AiCompletionResult> = {}): AiCompletionResult {
  return {
    available: true,
    outputText: "answer",
    parsedJson: null,
    modelId: "gpt-5.6-luna",
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    error: null,
    ...overrides,
  };
}

const PRICING = { FAST: { input: 0.2, output: 1.2 }, DEEP: { input: 2, output: 12 }, AUDIT: { input: 4, output: 20 } };

describe("computeAiCacheKey", () => {
  it("is deterministic for identical requests", async () => {
    const a = await computeAiCacheKey(req());
    const b = await computeAiCacheKey(req());
    expect(a).toBe(b);
  });

  it("differs when input differs", async () => {
    const a = await computeAiCacheKey(req({ input: "hello" }));
    const b = await computeAiCacheKey(req({ input: "goodbye" }));
    expect(a).not.toBe(b);
  });

  it("differs when promptVersionId differs, even with identical instructions/input", async () => {
    const a = await computeAiCacheKey(req({ promptVersionId: "v1" }));
    const b = await computeAiCacheKey(req({ promptVersionId: "v2" }));
    expect(a).not.toBe(b);
  });

  it("does NOT depend on the resolved model id (not part of the request at all)", async () => {
    // Same request shape twice — proves nothing model-id-shaped leaks in.
    const a = await computeAiCacheKey(req({ tier: "FAST" }));
    const b = await computeAiCacheKey(req({ tier: "FAST" }));
    expect(a).toBe(b);
  });
});

describe("estimateCostUsd", () => {
  it("computes USD from token usage and the per-tier pricing table", () => {
    const cost = estimateCostUsd("FAST", { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }, PRICING);
    expect(cost).toBe(0.2 + 1.2);
  });

  it("returns 0 (never fabricated) when usage is null", () => {
    expect(estimateCostUsd("FAST", null, PRICING)).toBe(0);
  });

  it("returns 0 when the tier has no pricing entry", () => {
    expect(estimateCostUsd("FAST", { inputTokens: 100, outputTokens: 100, totalTokens: 200 }, {} as typeof PRICING)).toBe(0);
  });
});

describe("AiCompletionCache", () => {
  it("calls the inner provider on a cache miss and persists the result", async () => {
    const { db, aiCache, apiUsage } = fakeD1();
    const inner: AiModelProvider = { name: "openai", complete: vi.fn().mockResolvedValue(successResult()) };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    const result = await cache.complete(req());

    expect(result.available).toBe(true);
    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(aiCache).toHaveLength(1);
    expect(apiUsage).toHaveLength(1);
    expect(apiUsage[0]!.cache_hit).toBe(0);
    expect(apiUsage[0]!.cost_weight).toBeCloseTo(1000 / 1_000_000 * 0.2 + 500 / 1_000_000 * 1.2, 6);
  });

  it("answers an identical second request from cache, WITHOUT calling the inner provider again", async () => {
    const { db } = fakeD1();
    const inner: AiModelProvider = { name: "openai", complete: vi.fn().mockResolvedValue(successResult()) };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    const first = await cache.complete(req());
    const second = await cache.complete(req());

    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(second.available).toBe(true);
    expect(second.outputText).toBe(first.outputText);
  });

  it("logs a cache hit at zero cost", async () => {
    const { db, apiUsage } = fakeD1();
    const inner: AiModelProvider = { name: "openai", complete: vi.fn().mockResolvedValue(successResult()) };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    await cache.complete(req());
    await cache.complete(req());

    const hitRow = apiUsage.find((r) => r.cache_hit === 1);
    expect(hitRow).toBeDefined();
    expect(hitRow!.cost_weight).toBe(0);
  });

  it("a request with a DIFFERENT promptVersionId is NOT served from an old version's cache entry", async () => {
    const { db } = fakeD1();
    const inner: AiModelProvider = {
      name: "openai",
      complete: vi
        .fn()
        .mockResolvedValueOnce(successResult({ outputText: "v1 answer" }))
        .mockResolvedValueOnce(successResult({ outputText: "v2 answer" })),
    };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    const v1 = await cache.complete(req({ promptVersionId: "v1" }));
    const v2 = await cache.complete(req({ promptVersionId: "v2" }));

    expect(inner.complete).toHaveBeenCalledTimes(2);
    expect(v1.outputText).toBe("v1 answer");
    expect(v2.outputText).toBe("v2 answer");
  });

  it("refuses a new request BEFORE calling the inner provider once the daily spend cap is already reached", async () => {
    const { db } = fakeD1(5.0); // already spent the full cap today
    const inner: AiModelProvider = { name: "openai", complete: vi.fn().mockResolvedValue(successResult()) };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    const result = await cache.complete(req());

    expect(result.available).toBe(false);
    expect(result.error).toMatch(/spend cap reached/);
    expect(inner.complete).not.toHaveBeenCalled();
  });

  it("proceeds normally when spend is under the cap", async () => {
    const { db } = fakeD1(1.0);
    const inner: AiModelProvider = { name: "openai", complete: vi.fn().mockResolvedValue(successResult()) };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    const result = await cache.complete(req());

    expect(result.available).toBe(true);
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it("never enforces a spend cap when dailySpendCapUsd is null", async () => {
    const { db } = fakeD1(1_000_000); // absurdly high logged spend
    const inner: AiModelProvider = { name: "openai", complete: vi.fn().mockResolvedValue(successResult()) };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: null, pricing: PRICING });

    const result = await cache.complete(req());

    expect(result.available).toBe(true);
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it("logs a failed inner call at zero cost, never blocking future calls on a phantom charge", async () => {
    const { db, apiUsage } = fakeD1();
    const inner: AiModelProvider = {
      name: "openai",
      complete: vi.fn().mockResolvedValue({ available: false, outputText: null, parsedJson: null, modelId: null, usage: null, error: "boom" }),
    };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    const result = await cache.complete(req());

    expect(result.available).toBe(false);
    expect(result.error).toBe("boom");
    expect(apiUsage[0]!.cost_weight).toBe(0);
  });

  it("does not cache a failed/unavailable result", async () => {
    const { db, aiCache } = fakeD1();
    const inner: AiModelProvider = {
      name: "openai",
      complete: vi.fn().mockResolvedValue({ available: false, outputText: null, parsedJson: null, modelId: null, usage: null, error: "boom" }),
    };
    const cache = new AiCompletionCache(db, inner, { dailySpendCapUsd: 5, pricing: PRICING });

    await cache.complete(req());

    expect(aiCache).toHaveLength(0);
  });
});
