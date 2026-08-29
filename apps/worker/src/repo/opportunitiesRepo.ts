import { Db } from "@mwmc/db";
import type { OpportunityCandidate } from "@mwmc/core";

export async function upsertOpportunity(db: Db, candidate: OpportunityCandidate, scanRunId: string): Promise<"created" | "updated"> {
  if (!candidate.cardPrintingHash) {
    // Identity-uncertain candidates aren't tied to a resolved card and are
    // surfaced directly from the scan result rather than persisted —
    // there's nothing stable to upsert against (see scanRunner.ts).
    return "created";
  }

  const existing = await db.queryFirst<{ id: string }>(
    `SELECT id FROM opportunities WHERE listing_id = ? AND strategy = ?`,
    candidate.listingId,
    candidate.strategy,
  );

  const id = existing?.id ?? crypto.randomUUID();

  await db.exec(
    `INSERT INTO opportunities (
       id, card_id, listing_id, scan_run_id, strategy, state, flip_score, grade_score,
       listing_price, total_acquisition_cost, liquidity, confidence,
       qsv, expected_net_sale_proceeds, expected_net_profit, return_on_capital, profit_margin, days_to_sale_estimate,
       total_graded_basis, psa6_profit, psa7_profit, psa8_profit, psa9_profit, psa10_profit, break_even_grade, psa10_upside_multiple,
       reasoning, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       flip_score = excluded.flip_score,
       grade_score = excluded.grade_score,
       scan_run_id = excluded.scan_run_id,
       reasoning = excluded.reasoning,
       updated_at = datetime('now')`,
    id,
    candidate.cardPrintingHash,
    candidate.listingId,
    scanRunId,
    candidate.strategy,
    candidate.state,
    candidate.flipScore,
    candidate.gradeScore,
    candidate.listingPrice,
    candidate.totalAcquisitionCost,
    candidate.liquidity,
    candidate.confidence,
    candidate.qsv ?? null,
    candidate.expectedNetSaleProceeds ?? null,
    candidate.expectedNetProfit ?? null,
    candidate.returnOnCapital ?? null,
    candidate.profitMargin ?? null,
    candidate.daysToSaleEstimate ?? null,
    candidate.totalGradedBasis ?? null,
    candidate.psa6Profit ?? null,
    candidate.psa7Profit ?? null,
    candidate.psa8Profit ?? null,
    candidate.psa9Profit ?? null,
    candidate.psa10Profit ?? null,
    candidate.breakEvenGrade ?? null,
    candidate.psa10UpsideMultiple ?? null,
    JSON.stringify(candidate.reasoning),
  );

  return existing ? "updated" : "created";
}
