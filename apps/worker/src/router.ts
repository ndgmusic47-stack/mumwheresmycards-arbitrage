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

app.get("/trade/api/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

app.notFound((c) => c.json({ error: "Not found" }, 404));
