import { Hono } from "hono";
import { Db } from "@mwmc/db";
import { createAiModelProvider, AiCompletionCache, GuardedAiModelProvider, AiQueryInterpreterProvider } from "@mwmc/providers";
import { loadSettings } from "../repo/settingsRepo.js";
import type { Env } from "../env.js";

export const queryInterpreterRoute = new Hono<{ Bindings: Env }>();

/**
 * AI INTELLIGENCE spec Phase 2, Workstream L: natural-language query
 * interpreter. `POST /arbitrage/api/query-interpret` — translates a
 * user-typed sentence into `DashboardFilters`' own fixed field set (see
 * `InterpretedOpportunityFilters` in packages/providers), which the web
 * client then merges onto the user's existing filter state and runs
 * through the exact same, already-validated `buildServerFilterParams`/
 * `applyDashboardFilters` pipeline a manually-adjusted slider would.
 * Read-only: this route never queries or writes `opportunities` itself,
 * only interprets text.
 *
 * Same provider-chain composition as Workstream J's `/advisory` route —
 * `createAiModelProvider(env)` (F) -> `AiCompletionCache` (G) ->
 * `GuardedAiModelProvider` (I) -> `AiQueryInterpreterProvider` (L itself)
 * — built fresh per request (depends on `c.env`/live Settings), never at
 * module scope.
 */
const MAX_QUERY_TEXT_LENGTH = 500;

queryInterpreterRoute.post("/", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<{ queryText?: unknown }>().catch(() => ({}) as { queryText?: unknown });

  if (typeof body.queryText !== "string" || body.queryText.trim().length === 0) {
    return c.json({ error: "queryText is required and must be a non-empty string" }, 400);
  }
  if (body.queryText.length > MAX_QUERY_TEXT_LENGTH) {
    return c.json({ error: `queryText must be ${MAX_QUERY_TEXT_LENGTH} characters or fewer` }, 400);
  }

  const settings = await loadSettings(db);
  const modelProvider = createAiModelProvider(c.env);
  const cached = new AiCompletionCache(db, modelProvider, {
    dailySpendCapUsd: settings.ai.dailySpendCapUsd,
    pricing: settings.ai.pricingUsdPerMTok,
    scanRunId: null,
  });
  const guarded = new GuardedAiModelProvider(cached);
  const interpreter = new AiQueryInterpreterProvider(guarded);

  const interpretation = await interpreter.interpretQuery({ queryText: body.queryText.trim() });

  return c.json({ interpretation, providerName: interpreter.name });
});
