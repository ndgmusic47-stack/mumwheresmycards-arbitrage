import { Hono } from "hono";
import { Db } from "@mwmc/db";
import type { Env } from "../env.js";
import { loadSettings, updateSetting } from "../repo/settingsRepo.js";

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
