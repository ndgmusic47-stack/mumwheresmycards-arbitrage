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

export const app = new Hono<HonoEnv>();

// Every /arbitrage/api/* route sits behind Cloudflare Access (edge policy)
// plus this defense-in-depth JWT check (see middleware/auth.ts).
app.use("/arbitrage/api/*", cloudflareAccessAuth);

app.route("/arbitrage/api/opportunities", opportunitiesRoute);
app.route("/arbitrage/api/scan-runs", scanRunsRoute);
app.route("/arbitrage/api/settings", settingsRoute);
app.route("/arbitrage/api/cards", cardsRoute);
app.route("/arbitrage/api/inventory", inventoryRoute);
app.route("/arbitrage/api/transactions", transactionsRoute);
app.route("/arbitrage/api/grading", gradingRoute);
app.route("/arbitrage/api/watchlist", watchlistRoute);
app.route("/arbitrage/api/market", marketRoute);
app.route("/arbitrage/api/catalogue", catalogueRoute);

app.get("/arbitrage/api/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

app.notFound((c) => c.json({ error: "Not found" }, 404));
