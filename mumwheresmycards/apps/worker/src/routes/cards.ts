import { Hono } from "hono";
import { Db, type CardRow, type MarketSnapshotRow } from "@mwmc/db";
import type { Env } from "../env.js";

export const cardsRoute = new Hono<{ Bindings: Env }>();

cardsRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const rows = await db.queryAll<CardRow>(`SELECT * FROM cards ORDER BY name LIMIT 200`);
  return c.json({ cards: rows });
});

cardsRoute.get("/:id", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");
  const card = await db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, id);
  if (!card) return c.json({ error: "Not found" }, 404);

  const snapshots = await db.queryAll<MarketSnapshotRow>(
    `SELECT * FROM market_snapshots WHERE card_id = ? ORDER BY captured_at DESC LIMIT 20`,
    id,
  );

  return c.json({ card, marketSnapshots: snapshots });
});
