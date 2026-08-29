import { Hono } from "hono";
import { Db, type InventoryRow, type TransactionRow } from "@mwmc/db";
import type { Env } from "../env.js";

export const transactionsRoute = new Hono<{ Bindings: Env }>();

transactionsRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const rows = await db.queryAll<TransactionRow>(`SELECT * FROM transactions ORDER BY sold_at DESC LIMIT 200`);
  return c.json({ transactions: rows });
});

interface CreateTransactionBody {
  inventoryId: string;
  salePrice: number;
  salePlatform?: string;
  marketplaceFees?: number;
  paymentProcessingFees?: number;
  outboundPostage?: number;
  insurance?: number;
  packaging?: number;
  soldAt?: string;
  buyerNotes?: string;
}

/**
 * Records the ACTUAL sale outcome — REAL cash proceeds/net profit/ROC and
 * days held, computed here (not trusted from the client) and kept
 * separate from the opportunity's forecast fields (ARCHITECTURE.md section 7).
 */
transactionsRoute.post("/", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<CreateTransactionBody>();

  const inventory = await db.queryFirst<InventoryRow>(`SELECT * FROM inventory WHERE id = ?`, body.inventoryId);
  if (!inventory) return c.json({ error: "inventoryId not found" }, 404);

  const marketplaceFees = body.marketplaceFees ?? 0;
  const paymentProcessingFees = body.paymentProcessingFees ?? 0;
  const outboundPostage = body.outboundPostage ?? 0;
  const insurance = body.insurance ?? 0;
  const packaging = body.packaging ?? 0;

  const realCashProceeds = body.salePrice - marketplaceFees - paymentProcessingFees - outboundPostage - insurance - packaging;
  const realNetProfit = realCashProceeds - inventory.actual_total_acquisition_cost;
  const realReturnOnCapital = inventory.actual_total_acquisition_cost > 0 ? realNetProfit / inventory.actual_total_acquisition_cost : 0;

  const soldAt = body.soldAt ?? new Date().toISOString();
  const daysHeld = Math.max(
    0,
    Math.round((new Date(soldAt).getTime() - new Date(inventory.purchased_at).getTime()) / (1000 * 60 * 60 * 24)),
  );

  const id = crypto.randomUUID();
  await db.exec(
    `INSERT INTO transactions (
       id, inventory_id, sale_price, sale_platform, marketplace_fees, payment_processing_fees,
       outbound_postage, insurance, packaging, real_cash_proceeds, real_net_profit, real_return_on_capital,
       days_held, sold_at, buyer_notes
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    body.inventoryId,
    body.salePrice,
    body.salePlatform ?? "EBAY",
    marketplaceFees,
    paymentProcessingFees,
    outboundPostage,
    insurance,
    packaging,
    realCashProceeds,
    realNetProfit,
    realReturnOnCapital,
    daysHeld,
    soldAt,
    body.buyerNotes ?? null,
  );

  await db.exec(`UPDATE inventory SET status = 'SOLD', updated_at = datetime('now') WHERE id = ?`, body.inventoryId);

  const row = await db.queryFirst<TransactionRow>(`SELECT * FROM transactions WHERE id = ?`, id);
  return c.json({ transaction: row }, 201);
});
