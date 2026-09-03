-- AI INTELLIGENCE spec Phase 2, Workstream G: AI response caching + cost
-- control. Mirrors the existing market_snapshots/MarketSnapshotCache
-- pattern (packages/providers/src/market/cache.ts) — this is the same idea
-- applied to AI completions instead of market data, and reuses the
-- EXISTING generic api_usage table (migration 0005) for cost logging
-- rather than inventing a parallel one; provider='openai',
-- endpoint=<AiModelTier> ('FAST'/'DEEP'/'AUDIT'), cost_weight=estimated
-- USD cost of that call (0 for a cache hit or a failed call, since neither
-- incurs real spend).
--
-- cache_key is a SHA-256 hex digest of the request's meaningfully-varying
-- fields (tier, instructions, input, images, responseSchema,
-- promptVersionId — images added 2026-09-03, AI INTELLIGENCE gap 2) —
-- see AiCompletionCache.ts's computeCacheKey(). Deliberately does NOT
-- include the resolved model id: the point of the cache is "have we asked
-- this exact question before", which shouldn't need re-asking just because
-- AI_FAST_MODEL was repointed to a different model id under the same tier.
-- promptVersionId IS part of the key (Workstream H) — a new prompt version
-- must never silently reuse an old prompt's cached answer.
CREATE TABLE ai_completion_cache (
  cache_key           TEXT PRIMARY KEY,
  tier                TEXT NOT NULL,
  model_id            TEXT,
  prompt_version_id   TEXT,
  output_text         TEXT,
  parsed_json         TEXT,
  usage_input_tokens  INTEGER,
  usage_output_tokens INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ai_completion_cache_created_at ON ai_completion_cache(created_at);
