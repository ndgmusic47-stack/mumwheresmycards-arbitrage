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
  /**
   * SECOND-GAME SUPPORT (2026-09-19). All three are optional; unset means
   * the tool behaves exactly as it did when it was Pokemon-only.
   *
   * JUSTTCG_GAMES pairs OUR game id with JUSTTCG'S OWN slug, comma
   * separated, e.g. "onepiece:one-piece-card-game". The slug is
   * configuration rather than a constant because JustTCG does not publish
   * its slug list and this project has already lost a day to a guessed API
   * path — call GET /games once and paste what it returns.
   */
  JUSTTCG_API_KEY?: string;
  JUSTTCG_GAMES?: string;
  /** Graded prices are a v2 feature; v1 returns none. Defaults to v2. */
  JUSTTCG_MARKET_BASE_URL?: string;
  /** The catalogue is read from v1, which is the documented stable one. */
  JUSTTCG_CATALOGUE_BASE_URL?: string;
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
