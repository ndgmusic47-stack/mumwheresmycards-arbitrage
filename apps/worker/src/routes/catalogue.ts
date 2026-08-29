import { Hono } from "hono";
import { Db, type CatalogueSyncRunRow, type CatalogueSyncCheckpointRow } from "@mwmc/db";
import { createCatalogueProvider } from "@mwmc/providers";
import type { Env } from "../env.js";
import { loadSettings } from "../repo/settingsRepo.js";
import { runCatalogueSyncJob } from "../catalogue/runCatalogueSyncJob.js";

export const catalogueRoute = new Hono<{ Bindings: Env }>();

/** Sync status/history — lets the dashboard show sync progress (pages
 *  fetched, cards inserted/updated/skipped, last completed full pass). */
catalogueRoute.get("/status", async (c) => {
  const db = new Db(c.env.DB);
  const checkpoint = await db.queryFirst<CatalogueSyncCheckpointRow>(
    `SELECT * FROM catalogue_sync_checkpoint WHERE provider = ?`,
    c.env.MARKET_PROVIDER,
  );
  const runs = await db.queryAll<CatalogueSyncRunRow>(
    `SELECT * FROM catalogue_sync_runs WHERE provider = ? ORDER BY started_at DESC LIMIT 20`,
    c.env.MARKET_PROVIDER,
  );
  return c.json({ checkpoint, runs });
});

/** Manual sync trigger — runs the same bounded, resumable sync step scans
 *  run automatically, for ops use (e.g. to bootstrap a fresh DB immediately
 *  rather than waiting for the next scheduled scan). */
catalogueRoute.post("/sync", async (c) => {
  const db = new Db(c.env.DB);
  const settings = await loadSettings(db);
  const provider = createCatalogueProvider(c.env.MARKET_PROVIDER, {
    poketraceApiKey: c.env.POKETRACE_API_KEY,
    poketraceBaseUrl: c.env.POKETRACE_API_BASE_URL,
  });
  const run = await runCatalogueSyncJob(db, provider, settings.catalogueSync);
  return c.json({ syncRun: run });
});
