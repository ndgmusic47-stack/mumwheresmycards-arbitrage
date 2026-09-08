import { describe, it, expect } from "vitest";
import { app } from "../src/router.js";
import type { Env } from "../src/env.js";

/**
 * REGRESSION GUARD, fixed 2026-09-03: wrangler.toml's `run_worker_first` is
 * scoped to `/trade/api/*` only, so in the common case a client-side route
 * like `/trade/flip` never reaches this Worker — Cloudflare serves it
 * directly from assets, falling back to the built SPA's index.html via
 * `not_found_handling = "single-page-application"`. But that automatic
 * fallback only applies to requests Cloudflare classifies as a top-level
 * "navigation" — confirmed live, a reload of a client-side route (e.g.
 * after an in-app error, or a bookmarked/pinned deep link) can reach this
 * Worker instead, and before this fix app.notFound() answered EVERY
 * unmatched path with the API's raw `{"error":"Not found"}` JSON — so the
 * user saw that bare JSON as the entire page instead of the app ever
 * loading, for any route beside the exact ones Cloudflare's own asset
 * matching or SPA fallback already covered. This test exercises
 * router.ts's `app` directly (no HTTP layer), so it stays a true unit test
 * of the notFound branch, not a Miniflare integration test.
 */

/** Fetcher double for the ASSETS binding — records what URL it was asked
 *  for and returns a recognizable body/headers so the test can assert this
 *  route actually reached the assets binding rather than, say, silently
 *  returning some other 200. */
function fakeAssets(): { fetcher: Env["ASSETS"]; requestedUrls: string[] } {
  const requestedUrls: string[] = [];
  const fetcher: Env["ASSETS"] = {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      return new Response("<html>SPA shell</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  } as unknown as Env["ASSETS"];
  return { fetcher, requestedUrls };
}

/** Fields beyond ASSETS are unused by the paths this file exercises (the
 *  notFound branch never touches DB/provider bindings), so they're typed
 *  through `as Env` rather than fully stubbed — same minimal-double
 *  approach as this suite's other route tests. */
function fakeEnv(assets: Env["ASSETS"]): Env {
  return { ASSETS: assets, ENVIRONMENT: "development" } as Env;
}

describe("app.notFound SPA fallback", () => {
  it("serves the built SPA's index.html for an unmatched non-API path, instead of the API's raw JSON 404", async () => {
    const { fetcher, requestedUrls } = fakeAssets();
    const res = await app.fetch(new Request("https://mumwheresmycards.com/trade/flip"), fakeEnv(fetcher));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>SPA shell</html>");
    expect(requestedUrls).toEqual(["https://mumwheresmycards.com/trade/index.html"]);
  });

  it("still answers an unmatched /trade/api/* path with the JSON 404, unchanged", async () => {
    const { fetcher, requestedUrls } = fakeAssets();
    const res = await app.fetch(new Request("https://mumwheresmycards.com/trade/api/not-a-real-route"), fakeEnv(fetcher));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    // Must NOT have fallen through to the assets fetch — an unknown API
    // path is a real 404, not a page for the SPA shell to route client-side.
    expect(requestedUrls).toEqual([]);
  });
});
