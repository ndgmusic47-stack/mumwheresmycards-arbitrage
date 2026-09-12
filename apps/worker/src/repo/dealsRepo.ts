import { Db } from "@mwmc/db";
import type { DealInputs, FxSnapshot } from "@mwmc/core";
import { DEAL_CALC_VERSION } from "@mwmc/core";

/**
 * Persistence for the per-card trading desk.
 *
 * TWO GUARANTEES THIS FILE EXISTS TO MAKE STRUCTURAL, not conventional:
 *
 *  1. A RESCAN NEVER TOUCHES THE OPERATOR'S ASSUMPTIONS. Deals live in their
 *     own table keyed by opportunity_id; `upsertOpportunity` cannot reach
 *     them. This is the same reasoning migration 0016 used to protect
 *     review_status, applied to a whole record instead of three columns.
 *
 *  2. AN OFFER IS NEVER EDITED OR DELETED. Revising writes a new row that
 *     points at the one it replaces. "What did I offer, and when did they
 *     say no" stays answerable forever, which is the entire point of keeping
 *     offer history rather than a single current-offer column.
 */

export interface DealRow {
  id: string;
  opportunity_id: string;
  card_id: string;
  strategy: string;
  grader_id: string | null;
  grading_service_name: string | null;
  inputs_json: string;
  fx_snapshot_json: string;
  calc_version: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const OFFER_STATUSES = ["PENDING", "ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Statuses that mean the offer is settled and no longer an exposure. */
export const RESOLVED_OFFER_STATUSES: OfferStatus[] = ["ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"];

export interface DealOfferRow {
  id: string;
  deal_id: string;
  amount: number;
  currency: string;
  rate_to_gbp: number | null;
  amount_gbp: number;
  status: OfferStatus;
  placed_at: string;
  resolved_at: string | null;
  expires_at: string | null;
  supersedes_id: string | null;
  note: string | null;
  created_at: string;
}

export async function getDealByOpportunity(db: Db, opportunityId: string): Promise<DealRow | null> {
  return db.queryFirst<DealRow>(`SELECT * FROM deals WHERE opportunity_id = ?`, opportunityId);
}

export async function getDealById(db: Db, id: string): Promise<DealRow | null> {
  return db.queryFirst<DealRow>(`SELECT * FROM deals WHERE id = ?`, id);
}

/**
 * Creates or replaces the operator's saved assumptions for one opportunity.
 *
 * The ON CONFLICT deliberately does NOT touch `created_at` — when a deal was
 * first worked is part of its history.
 */
export async function saveDeal(
  db: Db,
  params: {
    id: string;
    opportunityId: string;
    cardId: string;
    inputs: DealInputs;
    fx: FxSnapshot;
    notes?: string | null;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO deals (
       id, opportunity_id, card_id, strategy, grader_id, grading_service_name,
       inputs_json, fx_snapshot_json, calc_version, notes, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
     ON CONFLICT(opportunity_id) DO UPDATE SET
       strategy = excluded.strategy,
       grader_id = excluded.grader_id,
       grading_service_name = excluded.grading_service_name,
       inputs_json = excluded.inputs_json,
       fx_snapshot_json = excluded.fx_snapshot_json,
       calc_version = excluded.calc_version,
       notes = excluded.notes,
       updated_at = datetime('now')`,
    params.id,
    params.opportunityId,
    params.cardId,
    params.inputs.strategy,
    params.inputs.grading?.graderId ?? null,
    params.inputs.grading?.serviceName ?? null,
    JSON.stringify(params.inputs),
    JSON.stringify(params.fx),
    DEAL_CALC_VERSION,
    params.notes ?? null,
  );
}

export async function listOffers(db: Db, dealId: string): Promise<DealOfferRow[]> {
  return db.queryAll<DealOfferRow>(`SELECT * FROM deal_offers WHERE deal_id = ? ORDER BY placed_at DESC, rowid DESC`, dealId);
}

/** The one offer currently outstanding on a deal, if any. */
export async function getPendingOffer(db: Db, dealId: string): Promise<DealOfferRow | null> {
  return db.queryFirst<DealOfferRow>(
    `SELECT * FROM deal_offers WHERE deal_id = ? AND status = 'PENDING' ORDER BY placed_at DESC, rowid DESC LIMIT 1`,
    dealId,
  );
}

/**
 * Places an offer.
 *
 * Revising is explicit: an existing PENDING offer on the same deal is first
 * WITHDRAWN and recorded as superseded, so there is never more than one live
 * offer per deal and the previous figure is still readable. Silently leaving
 * two pending offers would double-count the exposure.
 */
export async function placeOffer(
  db: Db,
  params: {
    id: string;
    dealId: string;
    amount: number;
    currency: string;
    rateToGbp: number | null;
    amountGbp: number;
    expiresAt?: string | null;
    note?: string | null;
  },
): Promise<{ supersededId: string | null }> {
  const existing = await getPendingOffer(db, params.dealId);
  if (existing) {
    await db.exec(
      `UPDATE deal_offers SET status = 'WITHDRAWN', resolved_at = datetime('now') WHERE id = ? AND status = 'PENDING'`,
      existing.id,
    );
  }

  await db.exec(
    `INSERT INTO deal_offers (id, deal_id, amount, currency, rate_to_gbp, amount_gbp, status, placed_at, expires_at, supersedes_id, note)
     VALUES (?,?,?,?,?,?, 'PENDING', datetime('now'), ?, ?, ?)`,
    params.id,
    params.dealId,
    params.amount,
    params.currency,
    params.rateToGbp,
    params.amountGbp,
    params.expiresAt ?? null,
    existing?.id ?? null,
    params.note ?? null,
  );

  return { supersededId: existing?.id ?? null };
}

/**
 * Settles an offer. Guarded on the row still being PENDING so two clicks, or
 * two tabs, cannot resolve the same offer twice into different outcomes —
 * the second write matches nothing and reports it.
 */
export async function resolveOffer(
  db: Db,
  offerId: string,
  status: Exclude<OfferStatus, "PENDING">,
  note?: string | null,
): Promise<{ updated: boolean }> {
  const result = await db.exec(
    `UPDATE deal_offers
        SET status = ?, resolved_at = datetime('now'), note = COALESCE(?, note)
      WHERE id = ? AND status = 'PENDING'`,
    status,
    note ?? null,
    offerId,
  );
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  // A fake D1 in tests may not report `changes`; fall back to re-reading.
  if (typeof changes === "number") return { updated: changes > 0 };
  const row = await db.queryFirst<DealOfferRow>(`SELECT * FROM deal_offers WHERE id = ?`, offerId);
  return { updated: row?.status === status };
}

export async function getOffer(db: Db, offerId: string): Promise<DealOfferRow | null> {
  return db.queryFirst<DealOfferRow>(`SELECT * FROM deal_offers WHERE id = ?`, offerId);
}

/**
 * POTENTIAL acquisition spend — the sum of every PENDING offer.
 *
 * Deliberately its own function, and deliberately never added to actual
 * spend anywhere. A pending offer is money that would be committed IF
 * accepted; an inventory row is money already gone. Presenting one total for
 * both would misstate both.
 */
export async function pendingOfferExposure(db: Db): Promise<{ count: number; totalGbp: number }> {
  const row = await db.queryFirst<{ n: number; total: number | null }>(
    `SELECT COUNT(*) as n, SUM(amount_gbp) as total FROM deal_offers WHERE status = 'PENDING'`,
  );
  return { count: row?.n ?? 0, totalGbp: row?.total ?? 0 };
}

/** Actual money already spent, from inventory. Never mixed with the above. */
export async function actualAcquisitionSpend(db: Db): Promise<{ count: number; totalGbp: number }> {
  const row = await db.queryFirst<{ n: number; total: number | null }>(
    `SELECT COUNT(*) as n, SUM(actual_total_acquisition_cost) as total FROM inventory WHERE status != 'ARCHIVED'`,
  );
  return { count: row?.n ?? 0, totalGbp: row?.total ?? 0 };
}

/**
 * PLANNED grading cost — a third figure, never merged with the two above.
 *
 * This is money not yet spent on cards already owned: the grading side of the
 * frozen decision for every GRADE card that has not yet been graded. It is
 * read from the snapshot the operator committed against, not recomputed from
 * today's assumptions, because what matters here is what they planned to
 * spend when they bought.
 *
 * `uncosted` is reported rather than hidden: a card bought before this
 * feature existed, or bought outside the deal desk, has no planned figure at
 * all. Counting it as zero would understate the commitment, which is exactly
 * the failure mode this whole panel exists to avoid.
 */
export async function plannedGradingCost(db: Db): Promise<{ count: number; totalGbp: number; uncosted: number }> {
  const rows = await db.queryAll<{ decision_snapshot: string | null }>(
    `SELECT decision_snapshot FROM inventory
      WHERE strategy = 'GRADE' AND status IN ('PURCHASED', 'AWAITING_GRADING')`,
  );

  let total = 0;
  let count = 0;
  let uncosted = 0;
  for (const row of rows) {
    if (!row.decision_snapshot) {
      uncosted += 1;
      continue;
    }
    try {
      const snapshot = JSON.parse(row.decision_snapshot) as { calculation?: { grading?: { total?: unknown } } };
      const planned = snapshot.calculation?.grading?.total;
      if (typeof planned === "number" && Number.isFinite(planned)) {
        total += planned;
        count += 1;
      } else {
        uncosted += 1;
      }
    } catch {
      // A snapshot that will not parse is not a zero-cost card.
      uncosted += 1;
    }
  }

  return { count, totalGbp: Math.round(total * 100) / 100, uncosted };
}

export interface DealUnderOfferRow {
  deal_id: string;
  opportunity_id: string;
  card_id: string;
  strategy: string;
  card_name: string | null;
  set_name: string | null;
  card_number: string | null;
  listing_item_url: string | null;
  listing_status: string | null;
  offer_id: string;
  amount: number;
  currency: string;
  amount_gbp: number;
  placed_at: string;
  expires_at: string | null;
}

/**
 * THE STAGE BETWEEN "SAVED" AND "BOUGHT".
 *
 * Asked for directly: a lead you have made an offer on is not a lead any
 * more, and it is not stock either. It is money you have put on the table
 * and are waiting to hear about, and until now it sat in SAVED looking
 * identical to a card you had merely bookmarked.
 *
 * TWO EXCLUSIONS, both deliberate:
 *
 *  - Only PENDING offers. `placeOffer` withdraws the previous pending offer
 *    when a new one is placed, so this returns at most one row per deal and
 *    the amount shown is the live one, not a superseded figure.
 *
 *  - `inventory.deal_id IS NULL` — a deal already recorded as purchased has
 *    moved on, even if its offer row was never resolved. The pipeline shows
 *    each card in exactly one column; without this, a bought card would
 *    appear twice and the operator would be looking at their own money
 *    counted in two places.
 */
export async function dealsUnderOffer(db: Db): Promise<DealUnderOfferRow[]> {
  return db.queryAll<DealUnderOfferRow>(
    `SELECT d.id            AS deal_id,
            d.opportunity_id,
            d.card_id,
            d.strategy,
            c.name          AS card_name,
            c.set_name,
            c.card_number,
            l.item_url      AS listing_item_url,
            l.status         AS listing_status,
            o.id            AS offer_id,
            o.amount, o.currency, o.amount_gbp, o.placed_at, o.expires_at
       FROM deal_offers o
       JOIN deals d       ON d.id = o.deal_id
       LEFT JOIN cards c  ON c.id = d.card_id
       LEFT JOIN opportunities op ON op.id = d.opportunity_id
       LEFT JOIN ebay_listings l  ON l.id = op.listing_id
       LEFT JOIN inventory inv    ON inv.deal_id = d.id
      WHERE o.status = 'PENDING'
        AND inv.id IS NULL
      ORDER BY o.placed_at DESC`,
  );
}

export async function inventoryForDeal(db: Db, dealId: string): Promise<{ id: string } | null> {
  return db.queryFirst<{ id: string }>(`SELECT id FROM inventory WHERE deal_id = ?`, dealId);
}

/**
 * Records the purchase, freezing the decision.
 *
 * `decisionSnapshot` is the operator's OWN inputs and the calculation they
 * were looking at — not the scan's forecast, which `forecast_snapshot`
 * already holds separately. Both are written once and never rewritten: later
 * scans, later FX refreshes and later valuations all live outside this row.
 *
 * Duplicate prevention is enforced by a UNIQUE index on inventory.deal_id,
 * not by this check alone — the check exists to return a clear error instead
 * of a constraint violation, but the index is what makes it true under a
 * concurrent double-submit.
 */
export async function recordPurchaseFromDeal(
  db: Db,
  params: {
    inventoryId: string;
    dealId: string;
    opportunityId: string;
    cardId: string;
    strategy: string;
    purchasePrice: number;
    sellerPostage: number;
    importTax: number;
    otherFees: number;
    totalAcquisitionCost: number;
    sourceUrl?: string | null;
    decisionSnapshot: unknown;
    notes?: string | null;
  },
): Promise<{ created: boolean; existingInventoryId?: string }> {
  const existing = await inventoryForDeal(db, params.dealId);
  if (existing) return { created: false, existingInventoryId: existing.id };

  await db.exec(
    `INSERT INTO inventory (
       id, opportunity_id, card_id, strategy, status,
       actual_purchase_price, actual_seller_postage, actual_import_tax,
       actual_other_acquisition_fees, actual_total_acquisition_cost,
       source_url, purchased_at, notes, deal_id, decision_snapshot, created_at, updated_at
     ) VALUES (?,?,?,?, 'PURCHASED', ?,?,?,?,?,?, datetime('now'), ?,?,?, datetime('now'), datetime('now'))`,
    params.inventoryId,
    params.opportunityId,
    params.cardId,
    params.strategy,
    params.purchasePrice,
    params.sellerPostage,
    params.importTax,
    params.otherFees,
    params.totalAcquisitionCost,
    params.sourceUrl ?? null,
    params.notes ?? null,
    params.dealId,
    JSON.stringify(params.decisionSnapshot),
  );

  return { created: true };
}
