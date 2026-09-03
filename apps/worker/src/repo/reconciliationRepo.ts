import {
  Db,
  type InventoryRow,
  type TransactionRow,
  type GradingSubmissionRow,
  type GradingResultRow,
  type OpportunityRow,
  type CardRow,
} from "@mwmc/db";
import {
  computeRealisedEconomics,
  compareForecastVsRealised,
  round4,
  PSA_GRADES,
  type PsaGrade,
  type ForecastVsRealised,
} from "@mwmc/core";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream N: wires up the deterministic
 * reconciliation engine (`computeRealisedEconomics`/`compareForecastVsRealised`,
 * `packages/core/src/realised/realisedEconomics.ts`) against REAL data for
 * the first time. Those functions have existed and been tested since before
 * this phase, but nothing in this app actually called them — `POST
 * /arbitrage/api/transactions` records a realised sale with its own
 * simpler, standalone real-net-profit calculation (fine for what IT needs:
 * recording what actually happened), but nothing compared that outcome back
 * against `inventory.forecast_snapshot` — the frozen copy of the
 * opportunity as forecast at purchase. This file is that missing
 * comparison, built on top of the existing tested engine rather than a new
 * one.
 */

export interface ForecastTargets {
  forecastNetProfit: number | null;
  forecastReturnOnCapital: number | null;
  forecastCapitalLockDays: number | null;
}

/**
 * Reads the strategy-appropriate forecast figures out of a frozen
 * `forecast_snapshot` (a full `OpportunityRow` as it stood at purchase
 * time, per `inventoryRoute.post("/")`'s own doc comment).
 *
 * FLIP is straightforward — `expected_net_profit`/`return_on_capital` are
 * already single figures on the row. GRADE is NOT: an `OpportunityRow` has
 * no single "expected" profit for a GRADE card (deliberately — this app's
 * "REQUIRED never EXPECTED" discipline since Workstream E means it only
 * ever stores conditional-per-grade profit, `psa6_profit`..`psa10_profit`).
 * So the only honest GRADE comparison is against the forecast for the
 * SPECIFIC grade this card actually came back as — never a blended
 * "expected value" that was never actually forecast. A grade outside
 * `PSA_GRADES` (or no grade yet) has nothing to compare against, and
 * returns null rather than guessing.
 */
export function buildForecastTargets(
  forecastSnapshot: OpportunityRow | null,
  actualGradeNumeric: number | null,
): ForecastTargets {
  if (!forecastSnapshot) {
    return { forecastNetProfit: null, forecastReturnOnCapital: null, forecastCapitalLockDays: null };
  }

  const forecastCapitalLockDays = forecastSnapshot.estimated_capital_lock_days;

  if (forecastSnapshot.strategy === "FLIP") {
    return {
      forecastNetProfit: forecastSnapshot.expected_net_profit,
      forecastReturnOnCapital: forecastSnapshot.return_on_capital,
      forecastCapitalLockDays,
    };
  }

  // GRADE
  if (actualGradeNumeric === null || !(PSA_GRADES as readonly number[]).includes(actualGradeNumeric)) {
    return { forecastNetProfit: null, forecastReturnOnCapital: null, forecastCapitalLockDays };
  }

  const grade = actualGradeNumeric as PsaGrade;
  const forecastNetProfit = (forecastSnapshot as unknown as Record<string, number | null>)[`psa${grade}_profit`] ?? null;
  const basis = forecastSnapshot.total_graded_basis;
  const forecastReturnOnCapital =
    forecastNetProfit !== null && basis !== null && basis > 0 ? round4(forecastNetProfit / basis) : null;

  return { forecastNetProfit, forecastReturnOnCapital, forecastCapitalLockDays };
}

export interface ReconciliationRecord {
  inventoryId: string;
  cardId: string;
  cardName: string;
  strategy: "FLIP" | "GRADE";
  soldAt: string;
  /** null when this inventory row was never linked to an opportunity (a
   *  manually-added purchase) — never fabricated. `forecastVsRealised`'s
   *  own fields are then correctly all-null too, via `buildForecastTargets`. */
  hasForecast: boolean;
  actualGrade: number | null;
  forecastVsRealised: ForecastVsRealised;
}

const RECONCILIATION_LIMIT = 200;

/**
 * Loads every completed (sold) trade and reconciles it against its frozen
 * forecast — the real, DB-backed counterpart to `buildForecastTargets`
 * above. Deliberately several small queries rather than one large JOIN:
 * this is a bounded (`RECONCILIATION_LIMIT`), occasional analysis view —
 * same "N+1 is fine here" reasoning already accepted elsewhere in this app
 * for per-item detail fetches (e.g. `GET /opportunities/:id`), not the hot
 * paginated dashboard list-feed path `includeMarketRef` is gated behind.
 */
export async function loadReconciliationRecords(db: Db): Promise<ReconciliationRecord[]> {
  const transactions = await db.queryAll<TransactionRow>(
    `SELECT * FROM transactions ORDER BY sold_at DESC LIMIT ?`,
    RECONCILIATION_LIMIT,
  );

  const records: ReconciliationRecord[] = [];

  for (const transaction of transactions) {
    const inventory = await db.queryFirst<InventoryRow>(`SELECT * FROM inventory WHERE id = ?`, transaction.inventory_id);
    if (!inventory) continue; // orphaned transaction — shouldn't happen, but never fabricate a record for it

    const card = await db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, inventory.card_id);

    let gradingSubmission: GradingSubmissionRow | null = null;
    let gradingResult: GradingResultRow | null = null;
    if (inventory.strategy === "GRADE") {
      gradingSubmission = await db.queryFirst<GradingSubmissionRow>(
        `SELECT * FROM grading_submissions WHERE inventory_id = ? ORDER BY submitted_at DESC LIMIT 1`,
        inventory.id,
      );
      if (gradingSubmission) {
        gradingResult = await db.queryFirst<GradingResultRow>(
          `SELECT * FROM grading_results WHERE submission_id = ? ORDER BY returned_at DESC LIMIT 1`,
          gradingSubmission.id,
        );
      }
    }

    const realised = computeRealisedEconomics({
      acquisition: {
        purchasePrice: inventory.actual_purchase_price,
        sellerPostage: inventory.actual_seller_postage,
        importTax: inventory.actual_import_tax,
        otherFees: inventory.actual_other_acquisition_fees,
      },
      grading:
        gradingSubmission && gradingResult
          ? {
              gradingFee: gradingSubmission.actual_grading_fee,
              allocatedBatchCost: round2Sum(
                gradingSubmission.actual_postage_out,
                gradingSubmission.actual_insurance,
                gradingSubmission.actual_packaging,
                gradingResult.actual_return_postage,
              ),
            }
          : undefined,
      sale: {
        itemPrice: transaction.sale_price,
        outboundPostage: transaction.outbound_postage,
        packaging: transaction.packaging,
        insurance: transaction.insurance,
        actualSellingFees: round2Sum(transaction.marketplace_fees, transaction.payment_processing_fees),
      },
      purchasedAt: inventory.purchased_at,
      soldAt: transaction.sold_at,
    });

    let forecastSnapshot: OpportunityRow | null = null;
    if (inventory.forecast_snapshot) {
      try {
        forecastSnapshot = JSON.parse(inventory.forecast_snapshot) as OpportunityRow;
      } catch {
        // Malformed/unparseable snapshot (shouldn't happen — written by
        // this app's own purchase route) — treat as "no forecast" rather
        // than throwing and losing the whole reconciliation view.
        forecastSnapshot = null;
      }
    }

    const targets = buildForecastTargets(forecastSnapshot, gradingResult?.grade_numeric ?? null);
    const forecastVsRealised = compareForecastVsRealised({ ...targets, realised });

    records.push({
      inventoryId: inventory.id,
      cardId: inventory.card_id,
      cardName: card?.name ?? "Unknown card",
      strategy: inventory.strategy === "GRADE" ? "GRADE" : "FLIP",
      soldAt: transaction.sold_at,
      hasForecast: forecastSnapshot !== null,
      actualGrade: gradingResult?.grade_numeric ?? null,
      forecastVsRealised,
    });
  }

  return records;
}

function round2Sum(...values: (number | undefined)[]): number {
  return Math.round(values.reduce<number>((sum, v) => sum + (v ?? 0), 0) * 100) / 100;
}
