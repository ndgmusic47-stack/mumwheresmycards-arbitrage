import { Hono } from "hono";
import { Db, type OpportunityRow, type CardRow, type EbayListingRow } from "@mwmc/db";
import { loadOpportunityCounts } from "../repo/opportunitiesRepo.js";
import type { Env } from "../env.js";

export const opportunitiesRoute = new Hono<{ Bindings: Env }>();

interface OpportunityListItem extends OpportunityRow {
  card_name: string;
  card_set_name: string;
  card_set_code: string;
  card_number: string;
  card_edition: string;
  card_variant: string;
  card_finish: string;
  listing_title: string;
  listing_item_url: string;
  listing_type: string;
}

/**
 * GET /api/opportunities — the dashboard's "BEST OPPORTUNITIES NOW" feed.
 *
 * Query params:
 *   strategy=FLIP|GRADE|BOTH, state=..., limit= (page size, capped 500),
 *   offset= (page start), qualifiedOnly=true|false
 *
 * STABILISATION fix (item 1): this endpoint used to silently cap at 100/500
 * rows with no way to see how many candidates actually exist or page past
 * the first screen. It now returns `total` (rows matching the current
 * strategy/state/qualifiedOnly filter) and `counts` (a full breakdown of
 * every opportunity currently stored, independent of the filter, so the
 * dashboard can render "412 total candidates / 18 qualified flips / 26
 * grading candidates / 43 auctions / ... / 294 rejected" honestly instead of
 * only ever showing whatever fit in the first page).
 *
 * (Full dynamic filtering against live forecast fields is applied client-
 * side against this feed plus /api/settings' stored filter defaults —
 * heavier ad-hoc filter combinations can be pushed server-side later by
 * building a WHERE clause from the same FilterSet shape used by
 * packages/core/src/filters, without changing the response contract.)
 */
opportunitiesRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const strategy = c.req.query("strategy"); // FLIP | GRADE
  const state = c.req.query("state");
  const qualifiedOnlyParam = c.req.query("qualifiedOnly");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (strategy && strategy !== "BOTH") {
    conditions.push("o.strategy = ?");
    params.push(strategy);
  }
  if (state) {
    conditions.push("o.state = ?");
    params.push(state);
  }
  if (qualifiedOnlyParam === "true") {
    conditions.push("o.qualifies = 1");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows, totalRow, counts] = await Promise.all([
    db.queryAll<OpportunityListItem>(
      `SELECT o.*, c.name as card_name, c.set_name as card_set_name, c.set_code as card_set_code,
              c.card_number as card_number, c.edition as card_edition, c.variant as card_variant, c.finish as card_finish,
              l.title as listing_title, l.item_url as listing_item_url, l.listing_type as listing_type
       FROM opportunities o
       JOIN cards c ON c.id = o.card_id
       JOIN ebay_listings l ON l.id = o.listing_id
       ${where}
       -- Qualifying opportunities first (economics), then by ranking score
       -- within each group. Score orders; it never promotes a non-qualifying
       -- trade above a qualifying one.
       ORDER BY o.qualifies DESC, COALESCE(o.score, o.flip_score, o.grade_score) DESC
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    ),
    db.queryFirst<{ total: number }>(
      `SELECT COUNT(*) as total FROM opportunities o ${where}`,
      ...params,
    ),
    loadOpportunityCounts(db),
  ]);

  return c.json({
    opportunities: rows,
    total: totalRow?.total ?? 0,
    limit,
    offset,
    counts,
  });
});

opportunitiesRoute.get("/:id", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");

  const opportunity = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, id);
  if (!opportunity) return c.json({ error: "Not found" }, 404);

  const [card, listing] = await Promise.all([
    db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, opportunity.card_id),
    db.queryFirst<EbayListingRow>(`SELECT * FROM ebay_listings WHERE id = ?`, opportunity.listing_id),
  ]);

  return c.json({
    opportunity,
    card,
    listing: listing ? { ...listing, image_urls: listing.image_urls ? JSON.parse(listing.image_urls) : [] } : null,
    reasoning: opportunity.reasoning ? JSON.parse(opportunity.reasoning) : [],
  });
});
