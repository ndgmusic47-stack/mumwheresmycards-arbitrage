/**
 * SOURCING WORKFLOW item 7 — XLSX export.
 *
 * All the actual field-mapping logic (which columns, in what order, how
 * failure reasons get flattened) lives in @mwmc/core's export module, where
 * it's unit-tested without a browser. This file only turns those row arrays
 * into a real .xlsx file (via SheetJS) and triggers a download — no business
 * logic here.
 *
 * SheetJS is a real ~500KB-uncompressed dependency (see item 19's
 * performance concern) — imported dynamically inside exportOpportunitiesToXlsx
 * rather than at module load, so it only ever loads into the browser the
 * first time someone actually clicks "Export to XLSX", not on every
 * dashboard page load.
 */
import {
  buildFlipExportSheet,
  buildGradeExportSheet,
  type ExportableOpportunityRow,
} from "@mwmc/core";
import type { OpportunityListItem } from "../api/client";

/** Maps the API's OpportunityListItem shape onto the export module's
 *  DB-agnostic input type. A separate, explicit mapping (rather than
 *  reusing the API type directly in @mwmc/core) so the export column
 *  contract doesn't silently change shape just because the API response
 *  grows an unrelated field. */
export function toExportableRow(o: OpportunityListItem): ExportableOpportunityRow {
  return {
    strategy: o.strategy,
    state: o.state,
    qualification_failures: o.qualification_failures,
    card_id: o.card_id,
    card_name: o.card_name,
    card_set_name: o.card_set_name,
    card_number: o.card_number,
    card_variant: o.card_variant,
    card_finish: o.card_finish,
    listing_id: o.listing_id,
    listing_title: o.listing_title,
    listing_item_url: o.listing_item_url,
    listing_type: o.listing_type,
    listing_price: o.listing_price,
    listing_shipping_cost: o.listing_shipping_cost,
    listing_item_condition: o.listing_item_condition,
    listing_first_seen: o.listing_first_seen,
    listing_last_seen: o.listing_fetched_at,
    total_acquisition_cost: o.total_acquisition_cost,
    qsv: o.qsv,
    qsv_basis: o.qsv_basis,
    market_median_7d: o.market_median_7d ?? null,
    market_median_30d: o.market_median_30d ?? null,
    market_sample_size: o.market_sample_size ?? null,
    liquidity: o.liquidity,
    confidence: o.confidence,
    expected_net_sale_proceeds: o.expected_net_sale_proceeds,
    expected_net_profit: o.expected_net_profit,
    return_on_capital: o.return_on_capital,
    profit_margin: o.profit_margin,
    days_to_sale_estimate: o.days_to_sale_estimate,
    grader_id: o.grader_id,
    grading_service_name: o.grading_service_name,
    total_graded_basis: o.total_graded_basis,
    market_psa7: o.market_psa7 ?? null,
    market_psa8: o.market_psa8 ?? null,
    market_psa9: o.market_psa9 ?? null,
    market_psa10: o.market_psa10 ?? null,
    psa7_profit: o.psa7_profit,
    psa8_profit: o.psa8_profit,
    psa9_profit: o.psa9_profit,
    psa10_profit: o.psa10_profit,
    break_even_grade: o.break_even_grade,
    required_psa10_rate_vs_psa9: o.required_psa10_rate_vs_psa9,
    estimated_capital_lock_days: o.estimated_capital_lock_days,
    economic_class: o.economic_class,
  };
}

/**
 * Builds one workbook from a set of opportunities, splitting FLIP and GRADE
 * rows onto their own sheets (each with that strategy's full field list —
 * never mixing GRADE-only columns into a FLIP sheet or vice versa) and
 * triggers a browser download. A sheet with zero matching rows is still
 * included, header-only, rather than silently omitted — so "0 grade rows in
 * this export" is visible in the file, not indistinguishable from "grade
 * export wasn't implemented".
 */
export async function exportOpportunitiesToXlsx(rows: OpportunityListItem[], filenameHint: string): Promise<void> {
  const XLSX = await import("xlsx");
  const exportable = rows.map(toExportableRow);
  const flipRows = exportable.filter((r) => r.strategy === "FLIP");
  const gradeRows = exportable.filter((r) => r.strategy === "GRADE");

  const workbook = XLSX.utils.book_new();

  if (flipRows.length > 0 || gradeRows.length === 0) {
    const flipSheet = XLSX.utils.aoa_to_sheet(buildFlipExportSheet(flipRows));
    XLSX.utils.book_append_sheet(workbook, flipSheet, "Flip");
  }
  if (gradeRows.length > 0) {
    const gradeSheet = XLSX.utils.aoa_to_sheet(buildGradeExportSheet(gradeRows));
    XLSX.utils.book_append_sheet(workbook, gradeSheet, "Grade");
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  XLSX.writeFile(workbook, `mwmc-${filenameHint}-${timestamp}.xlsx`);
}
