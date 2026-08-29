import { Hono } from "hono";
import { Db, type WatchlistCardRow } from "@mwmc/db";
import type { Env } from "../env.js";

export const watchlistRoute = new Hono<{ Bindings: Env }>();

/**
 * CRUD for the seed grading watchlist (~31 researched cards, per spec —
 * imported via scripts/import-watchlist.ts, never hardcoded into engine
 * logic). This route is pure data management; it plays no part in
 * scanRunner's target selection until a watchlist entry is resolved into
 * a `cards` row.
 */
watchlistRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const rows = await db.queryAll<WatchlistCardRow>(`SELECT * FROM watchlist_cards WHERE active = 1 ORDER BY priority DESC`);
  return c.json({ watchlist: rows });
});

interface CreateWatchlistBody {
  label: string;
  cardId?: string;
  strategy?: "FLIP" | "GRADE" | "BOTH";
  source?: string;
  priority?: number;
  notes?: string;
}

watchlistRoute.post("/", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<CreateWatchlistBody>();
  const id = crypto.randomUUID();

  await db.exec(
    `INSERT INTO watchlist_cards (id, card_id, label, strategy, source, priority, notes)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    body.cardId ?? null,
    body.label,
    body.strategy ?? "GRADE",
    body.source ?? null,
    body.priority ?? 0,
    body.notes ?? null,
  );

  const row = await db.queryFirst<WatchlistCardRow>(`SELECT * FROM watchlist_cards WHERE id = ?`, id);
  return c.json({ watchlistCard: row }, 201);
});
