import { app } from "./router.js";
import type { Env } from "./env.js";
import { runScan } from "./scan/scanRunner.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // /trade/api/* is handled by the Hono app; everything else is the
    // built React SPA, served via the ASSETS binding (see wrangler.toml
    // `run_worker_first` — only API paths reach this fetch() at all).
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScan(env, "CRON").catch((err) => {
        // runScan already records the failure on the scan_runs row; this
        // catch just stops an unhandled rejection from surfacing as a
        // Worker exception in the Cloudflare dashboard.
        console.error("Scheduled scan failed:", err);
      }),
    );
  },
};
