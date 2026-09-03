import { Hono } from "hono";
import { Db, type ScanRunRow } from "@mwmc/db";
import type { Env } from "../env.js";
import { runScan } from "../scan/scanRunner.js";

export const scanRunsRoute = new Hono<{ Bindings: Env }>();

scanRunsRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const rows = await db.queryAll<ScanRunRow>(`SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 50`);
  return c.json({ scanRuns: rows });
});

/** Manual scan trigger (dashboard "Scan now" button / ops use). */
scanRunsRoute.post("/", async (c) => {
  const {
    scanRun,
    cardsProfiledThisRun,
    cardsSearchedThisRun,
    ebayApiCallsThisRun,
    duplicateListingsThisRun,
    endedAuctionListingsExpiredThisRun,
    enrichedListingsThisRun,
    aiReviewedThisRun,
  } = await runScan(c.env, "MANUAL");
  return c.json({
    scanRun,
    cardsProfiledThisRun,
    cardsSearchedThisRun,
    ebayApiCallsThisRun,
    duplicateListingsThisRun,
    endedAuctionListingsExpiredThisRun,
    enrichedListingsThisRun,
    aiReviewedThisRun,
  });
});
