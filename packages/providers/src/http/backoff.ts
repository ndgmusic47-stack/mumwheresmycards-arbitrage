/**
 * Shared 429/rate-limit backoff for any provider adapter that calls a real
 * HTTP API (PokeTrace's market + catalogue endpoints today). PokeTrace's
 * documented contract returns `X-RateLimit-Limit` / `X-RateLimit-Remaining`
 * / `X-RateLimit-Reset` headers and a 429 status when a plan's quota is
 * exceeded — this respects `Retry-After` first (standard HTTP), falling
 * back to `X-RateLimit-Reset` (seconds-until-reset), then a fixed default.
 *
 * API QUOTA PROTECTION: this is what stands between a runaway sync/scan
 * and burning through a whole day's API quota on retries — every caller
 * that hits PokeTrace goes through this, never a raw `fetch` retry loop.
 */
export interface BackoffOptions {
  maxRetries?: number;
  /** Injectable so tests don't actually wait — defaults to a real sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Fallback wait when no rate-limit header is present. */
  defaultRetryAfterMs?: number;
  /** Upper bound on any single computed wait, how ever it was derived. */
  maxWaitMs?: number;
}

const DEFAULTS: Required<BackoffOptions> = {
  maxRetries: 3,
  sleepImpl: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  defaultRetryAfterMs: 2000,
  maxWaitMs: 30_000,
};

export class RateLimitExceededError extends Error {
  constructor(public readonly attempts: number) {
    super(`Rate limit exceeded after ${attempts} attempt(s) — giving up.`);
    this.name = "RateLimitExceededError";
  }
}

/**
 * Calls `doFetch` and retries on HTTP 429 with a backoff delay derived from
 * response headers, up to `maxRetries` additional attempts. Any other
 * response (including other error statuses) is returned as-is for the
 * caller to handle — this function's only job is 429 handling.
 */
export async function fetchWithBackoff(
  doFetch: () => Promise<Response>,
  options: BackoffOptions = {},
): Promise<Response> {
  const opts = { ...DEFAULTS, ...options };
  let attempt = 0;

  for (;;) {
    const response = await doFetch();
    if (response.status !== 429) return response;

    attempt++;
    if (attempt > opts.maxRetries) {
      throw new RateLimitExceededError(attempt);
    }

    const waitMs = Math.min(opts.maxWaitMs, computeWaitMs(response, opts.defaultRetryAfterMs));
    await opts.sleepImpl(waitMs);
  }
}

function computeWaitMs(response: Response, fallbackMs: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  }

  const resetHeader = response.headers.get("X-RateLimit-Reset");
  if (resetHeader) {
    const seconds = Number(resetHeader);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  }

  return fallbackMs;
}
