import type { Db, AiCompletionCacheRow } from "@mwmc/db";
import { recordApiUsage } from "../apiUsage.js";
import type { AiCompletionRequest, AiCompletionResult, AiCompletionUsage, AiModelProvider, AiModelTier } from "./AiModelProvider.js";

export interface AiPricingEntry {
  /** USD per 1,000,000 INPUT tokens. */
  input: number;
  /** USD per 1,000,000 OUTPUT tokens. */
  output: number;
}

export type AiPricingTable = Record<AiModelTier, AiPricingEntry>;

export interface AiCompletionCacheOptions {
  /** Hard daily spend ceiling in USD across every tier combined — once
   *  today's logged spend reaches this, NO further real AI calls are made
   *  (cache hits still work, since they cost nothing) until the next UTC
   *  day. `null` means no cap — every caller of createAiModelProvider()
   *  should think hard before passing null in a real environment. */
  dailySpendCapUsd: number | null;
  /** Estimated USD cost per tier — see settingsRepo.ts's
   *  DEFAULT_AI_PRICING_USD_PER_MTOK doc comment for why these are
   *  estimates, not verified invoice figures, and are user-editable via
   *  Settings for exactly that reason. */
  pricing: AiPricingTable;
  scanRunId?: string | null;
}

/**
 * AI INTELLIGENCE spec Phase 2, Workstream G (caching + cost control).
 *
 * D1-backed cache + spend-cap gate in front of an AiModelProvider — the
 * SAME architectural role MarketSnapshotCache already plays in front of a
 * MarketDataProvider (packages/providers/src/market/cache.ts): this is the
 * ONE place that decides whether a real model call happens, so every AI
 * feature that wraps its inner provider with this class gets caching and
 * cost control for free, in one place, rather than each feature having to
 * remember to implement its own.
 *
 * Wraps ANY AiModelProvider, including NullAiModelProvider — when no API
 * key is configured, wrapping is harmless (nothing to cache, nothing to
 * spend, every call still reports unavailable exactly as before).
 *
 * TWO SEPARATE PROTECTIONS, in this order:
 * 1. CACHE — an identical request (same tier/instructions/input/schema/
 *    promptVersionId) already answered is returned from D1, at zero cost,
 *    without ever touching the network.
 * 2. SPEND CAP — a genuinely new request is refused BEFORE it's sent if
 *    today's already-logged spend has reached dailySpendCapUsd. This is a
 *    hard stop, not a warning: a request over budget never reaches the
 *    real API. Every real call's actual cost (from OpenAI's own returned
 *    token usage) is logged via the existing api_usage table immediately
 *    after it completes, so the NEXT call's cap check sees it.
 */
export class AiCompletionCache implements AiModelProvider {
  readonly name: string;

  constructor(
    private readonly db: Db,
    private readonly inner: AiModelProvider,
    private readonly options: AiCompletionCacheOptions,
  ) {
    this.name = `cached(${inner.name})`;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const cacheKey = await computeAiCacheKey(request);

    const cached = await this.db.queryFirst<AiCompletionCacheRow>(
      `SELECT * FROM ai_completion_cache WHERE cache_key = ?`,
      cacheKey,
    );
    if (cached) {
      await recordApiUsage(this.db, {
        provider: this.inner.name,
        endpoint: request.tier,
        scanRunId: this.options.scanRunId,
        cacheHit: true,
        costWeight: 0,
      });
      return rowToResult(cached, request.promptVersionId);
    }

    if (this.options.dailySpendCapUsd !== null) {
      const spentToday = await getTodaysAiSpendUsd(this.db, this.inner.name);
      if (spentToday >= this.options.dailySpendCapUsd) {
        return {
          available: false,
          outputText: null,
          parsedJson: null,
          modelId: null,
          usage: null,
          error:
            `AI daily spend cap reached: $${spentToday.toFixed(4)} already spent today against a ` +
            `$${this.options.dailySpendCapUsd.toFixed(2)} cap. No further real AI calls will be made ` +
            `until the cap resets (next UTC day) — this request was refused BEFORE calling the model, ` +
            `not truncated mid-call. Raise dailySpendCapUsd in Settings if this cap is too tight.`,
          promptVersionId: request.promptVersionId,
        };
      }
    }

    const result = await this.inner.complete(request);

    if (!result.available) {
      // No real spend on a failed/unavailable call — logged for call-volume
      // visibility, but at zero cost.
      await recordApiUsage(this.db, {
        provider: this.inner.name,
        endpoint: request.tier,
        scanRunId: this.options.scanRunId,
        cacheHit: false,
        costWeight: 0,
      });
      return result;
    }

    const costUsd = estimateCostUsd(request.tier, result.usage, this.options.pricing);
    await recordApiUsage(this.db, {
      provider: this.inner.name,
      endpoint: request.tier,
      scanRunId: this.options.scanRunId,
      cacheHit: false,
      costWeight: costUsd,
    });
    await this.persist(cacheKey, request, result);

    return result;
  }

  private async persist(cacheKey: string, request: AiCompletionRequest, result: AiCompletionResult): Promise<void> {
    await this.db.exec(
      `INSERT INTO ai_completion_cache (
         cache_key, tier, model_id, prompt_version_id,
         output_text, parsed_json, usage_input_tokens, usage_output_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO NOTHING`,
      cacheKey,
      request.tier,
      result.modelId,
      request.promptVersionId ?? null,
      result.outputText,
      result.parsedJson !== null ? JSON.stringify(result.parsedJson) : null,
      result.usage?.inputTokens ?? null,
      result.usage?.outputTokens ?? null,
    );
  }
}

/**
 * SHA-256 hex digest of the request's meaningfully-varying fields — see
 * migration 0019's doc comment for exactly what's included and why
 * (notably: NOT the resolved model id). Pure and deterministic — same
 * request, same key, every time, so this is directly unit-testable without
 * any D1/network dependency.
 */
export async function computeAiCacheKey(request: AiCompletionRequest): Promise<string> {
  const canonical = JSON.stringify({
    tier: request.tier,
    instructions: request.instructions,
    input: request.input,
    responseSchemaName: request.responseSchema?.name ?? null,
    responseSchema: request.responseSchema?.schema ?? null,
    promptVersionId: request.promptVersionId ?? null,
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * usage -> USD, from OpenAI's own returned token counts and the configured
 * per-tier pricing table. Returns 0 (never a fabricated cost) when usage or
 * that tier's pricing is missing — a real spend cap should never be
 * silently bypassed by a missing pricing entry, so callers that care about
 * an unpriced tier should notice a suspiciously-always-zero cost, not trust
 * it blindly.
 */
export function estimateCostUsd(tier: AiModelTier, usage: AiCompletionUsage | null, pricing: AiPricingTable): number {
  if (!usage) return 0;
  const entry = pricing[tier];
  if (!entry) return 0;
  const cost = (usage.inputTokens / 1_000_000) * entry.input + (usage.outputTokens / 1_000_000) * entry.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

async function getTodaysAiSpendUsd(db: Db, provider: string): Promise<number> {
  const row = await db.queryFirst<{ total: number | null }>(
    `SELECT COALESCE(SUM(cost_weight), 0) as total FROM api_usage WHERE provider = ? AND called_at >= datetime('now', 'start of day')`,
    provider,
  );
  return row?.total ?? 0;
}

function rowToResult(row: AiCompletionCacheRow, requestPromptVersionId?: string): AiCompletionResult {
  return {
    available: true,
    outputText: row.output_text,
    parsedJson: row.parsed_json !== null ? safeParseJson(row.parsed_json) : null,
    modelId: row.model_id,
    usage:
      row.usage_input_tokens !== null && row.usage_output_tokens !== null
        ? {
            inputTokens: row.usage_input_tokens,
            outputTokens: row.usage_output_tokens,
            totalTokens: row.usage_input_tokens + row.usage_output_tokens,
          }
        : null,
    error: null,
    promptVersionId: requestPromptVersionId ?? row.prompt_version_id ?? undefined,
  };
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
