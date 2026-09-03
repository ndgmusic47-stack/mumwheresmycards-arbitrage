export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // Non-secret vars (wrangler.toml [vars])
  ENVIRONMENT: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  MARKET_PROVIDER: "mock" | "poketrace";
  EBAY_PROVIDER: "mock" | "ebay-browse";
  DEFAULT_LISTING_REFRESH_MINUTES: string;
  DEFAULT_MARKET_REFRESH_HOURS: string;

  // Secrets (wrangler secret put)
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_MARKETPLACE_ID?: string;
  EBAY_OAUTH_SCOPE?: string;
  POKETRACE_API_KEY?: string;
  POKETRACE_API_BASE_URL?: string;
  CF_ACCESS_AUD?: string;
  // AI INTELLIGENCE Phase 2 (packages/providers/src/ai/). Absent
  // OPENAI_API_KEY -> createAiModelProvider() returns NullAiModelProvider,
  // so every AI feature is a safe no-op until a real key is added — the
  // user's own explicit "build it wired for a key, test later" decision.
  OPENAI_API_KEY?: string;
  AI_FAST_MODEL?: string;
  AI_DEEP_MODEL?: string;
  AI_AUDIT_MODEL?: string;
  AI_BASE_URL?: string;
}

export interface AccessIdentity {
  email?: string;
  sub?: string;
}

/** Shared Hono generics — Bindings (env/secrets) + Variables (per-request context set by middleware). */
export interface HonoEnv {
  Bindings: Env;
  Variables: {
    accessIdentity?: AccessIdentity;
  };
}
