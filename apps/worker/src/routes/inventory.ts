import { Hono } from "hono";
import { Db, type InventoryRow, type OpportunityRow } from "@mwmc/db";
import { computeAcquisitionCost } from "@mwmc/core";
import type { Env } from "../env.js";

export const inventoryRoute = new Hono<{ Bindings: Env }>();

inventoryRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const status = c.req.query("status");
  const rows = status
    ? await db.queryAll<InventoryRow>(`SELECT * FROM inventory WHERE status = ? ORDER BY purchased_at DESC`, status)
    : await db.queryAll<InventoryRow>(`SELECT * FROM inventory ORDER BY purchased_at DESC`);
  return c.json({ inventory: rows });
});

interface CreateInventoryBody {
  opportunityId?: string;
  cardId: string;
  strategy: "FLIP" | "GRADE";
  actualPurchasePrice: number;
  actualSellerPostage?: number;
  actualImportTax?: number;
  actualOtherAcquisitionFees?: number;
  sourceUrl?: string;
  notes?: string;
}

/**
 * Records the ACTUAL purchase of a card — the moment forecast economics
 * (stored on `opportunities`, never mutated) become realised economics
 * (see ARCHITECTURE.md section 7). The opportunity row is left untouched;
 * this is a new, separate row.
 */
inventoryRoute.post("/", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<CreateInventoryBody>();

  // FREEZE THE FORECAST. A copy of the opportunity exactly as it was
  // forecast at purchase time is stored on the inventory row, so realised
  // performance is always compared against what we actually believed when
  // we committed the money — never against a forecast silently recomputed
  // later against newer market data. See @mwmc/core compareForecastVsRealised.
  let forecastSnapshot: string | null = null;
  if (body.opportunityId) {
    const opp = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, body.opportunityId);
    if (!opp) return c.json({ error: "opportunityId not found" }, 404);
    forecastSnapshot = JSON.stringify(opp);
  }

  const acquisition = computeAcquisitionCost({
    purchasePrice: body.actualPurchasePrice,
    sellerPostage: body.actualSellerPostage ?? 0,
    importTax: body.actualImportTax,
    acquisitionFees: body.actualOtherAcquisitionFees,
  });

  const id = crypto.randomUUID();
  await db.exec(
    `INSERT INTO inventory (
       id, opportunity_id, card_id, strategy, status,
       actual_purchase_price, actual_seller_postage, actual_import_tax, actual_other_acquisition_fees,
       actual_total_acquisition_cost, source_url, notes,
       forecast_snapshot, forecast_frozen_at
     ) VALUES (?,?,?,?,'PURCHASED',?,?,?,?,?,?,?,?, datetime('now'))`,
    id,
    body.opportunityId ?? null,
    body.cardId,
    body.strategy,
    acquisition.purchasePrice,
    acquisition.sellerPostage,
    acquisition.importTax,
    acquisition.acquisitionFees,
    acquisition.total,
    body.sourceUrl ?? null,
    body.notes ?? null,
    forecastSnapshot,
  );

  const row = await db.queryFirst<InventoryRow>(`SELECT * FROM inventory WHERE id = ?`, id);
  return c.json({ inventory: row }, 201);
});

inventoryRoute.patch("/:id/status", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");
  const { status } = await c.req.json<{ status: InventoryRow["status"] }>();
  await db.exec(`UPDATE inventory SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, id);
  const row = await db.queryFirst<InventoryRow>(`SELECT * FROM inventory WHERE id = ?`, id);
  return c.json({ inventory: row });
});
