import { Hono } from "hono";
import { Db } from "@mwmc/db";
import type { Env } from "../env.js";
import { loadSettings, updateSetting, listSettingHistory } from "../repo/settingsRepo.js";

export const settingsRoute = new Hono<{ Bindings: Env }>();

settingsRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const settings = await loadSettings(db);
  return c.json(settings);
});

/** Body: { value: <json> } — key is one of the settings table rows (see migration 0005). */
settingsRoute.put("/:key", async (c) => {
  const db = new Db(c.env.DB);
  const key = c.req.param("key");
  const body = await c.req.json<{ value: unknown }>();
  await updateSetting(db, key, body.value);
  const settings = await loadSettings(db);
  return c.json(settings);
});

/**
 * AI INTELLIGENCE gap 4 (financial engineering): read-only history for one
 * settings key — every value+version it held before being superseded. See
 * settingsRepo.ts's updateSetting()/listSettingHistory() and migration
 * 0022_settings_versioning.sql for what this is versioning and why.
 */
settingsRoute.get("/:key/history", async (c) => {
  const db = new Db(c.env.DB);
  const key = c.req.param("key");
  const history = await listSettingHistory(db, key);
  return c.json({ key, history });
});
