import { Hono } from "hono";
import type { HonoEnv } from "./env.js";
import { cloudflareAccessAuth } from "./middleware/auth.js";
import { opportunitiesRoute } from "./routes/opportunities.js";
import { scanRunsRoute } from "./routes/scanRuns.js";
import { settingsRoute } from "./routes/settings.js";
import { cardsRoute } from "./routes/cards.js";
import { inventoryRoute } from "./routes/inventory.js";
import { transactionsRoute } from "./routes/transactions.js";
import { gradingRoute } from "./routes/grading.js";
import { watchlistRoute } from "./routes/watchlist.js";
import { marketRoute } from "./routes/market.js";
import { catalogueRoute } from "./routes/catalogue.js";
import { financialAssumptionsRoute } from "./routes/financialAssumptions.js";
import { maxBuyRoute } from "./routes/maxBuy.js";
import { capitalAllocationRoute } from "./routes/capitalAllocation.js";
import { queryInterpreterRoute } from "./routes/queryInterpreter.js";
import { dealsRoute } from "./routes/deals.js";
import { photoAssessmentRoute } from "./routes/photoAssessment.js";
import { scenarioRoute } from "./routes/scenario.js";
import { reconciliationRoute } from "./routes/reconciliation.js";

export const app = new Hono<HonoEnv>();

// Every /trade/api/* route sits behind Cloudflare Access (edge policy)
// plus this defense-in-depth JWT check (see middleware/auth.ts).
app.use("/trade/api/*", cloudflareAccessAuth);

app.route("/trade/api/opportunities", opportunitiesRoute);
// AI INTELLIGENCE spec Phase 2, Workstream M: mounted at the same base path
// as opportunitiesRoute above (Hono composes multiple .route() calls at the
// same prefix additively) so /:id/scenario reads as a sibling of
// opportunitiesRoute's own /:id, /:id/review, /:id/advisory etc., without
// having to fold scenario.ts's own concerns into that already-large file.
app.route("/trade/api/opportunities", scenarioRoute);
app.route("/trade/api/scan-runs", scanRunsRoute);
app.route("/trade/api/settings", settingsRoute);
app.route("/trade/api/cards", cardsRoute);
app.route("/trade/api/inventory", inventoryRoute);
app.route("/trade/api/transactions", transactionsRoute);
app.route("/trade/api/grading", gradingRoute);
app.route("/trade/api/watchlist", watchlistRoute);
app.route("/trade/api/market", marketRoute);
app.route("/trade/api/catalogue", catalogueRoute);
app.route("/trade/api/financial-assumptions", financialAssumptionsRoute);
app.route("/trade/api/max-buy", maxBuyRoute);
app.route("/trade/api/capital-allocation", capitalAllocationRoute);
app.route("/trade/api/query-interpret", queryInterpreterRoute);
app.route("/trade/api/reconciliation", reconciliationRoute);
// Per-card trading desk: saved deal assumptions, offer lifecycle, purchase.
app.route("/trade/api/deals", dealsRoute);
app.route("/trade/api/photo-assessment", photoAssessmentRoute);

app.get("/trade/api/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

/**
 * wrangler.toml's `run_worker_first` is scoped to `/trade/api/*` only, so in
 * the common case a client-side route like `/trade/flip` or
 * `/trade/opportunity/:id` never reaches this Worker at all — Cloudflare's
 * own asset serving handles it directly, and its
 * `not_found_handling = "single-page-application"` config re-serves the
 * built SPA's index.html for any such not-found path (see apps/web's
 * vite.config.ts doc comment for why that index.html lives at
 * dist/trade/index.html rather than dist/index.html).
 *
 * BUT that automatic SPA fallback is documented to apply only to requests
 * Cloudflare classifies as a top-level "navigation" — anything it doesn't
 * classify that way still falls through to this Worker's fetch() handler as
 * a last resort, landing here. Confirmed live 2026-09-03: clicking into an
 * opportunity's detail page and hitting a client-side error triggered a
 * reload of the current route (/trade/flip), and that reload's request
 * wasn't treated as a navigation, so it reached this Hono app instead of
 * getting the SPA fallback — surfacing this raw `{"error":"Not found"}` API
 * shape as the entire page instead of the app ever loading. Any genuinely
 * unmatched /trade/api/* path still gets that same JSON, unchanged; every
 * other path gets the SPA shell itself, so React Router (not this backend)
 * decides whether the route is real. This makes the SPA fallback work
 * regardless of Cloudflare's own navigation-detection, at the cost of one
 * extra internal fetch on the rare path that isn't already handled before
 * ever reaching the Worker.
 */
app.notFound(async (c) => {
  if (c.req.path.startsWith("/trade/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const indexUrl = new URL("/trade/index.html", c.req.url);
  const assetResponse = await c.env.ASSETS.fetch(new Request(indexUrl, { method: "GET" }));
  return new Response(assetResponse.body, { status: 200, headers: assetResponse.headers });
});
