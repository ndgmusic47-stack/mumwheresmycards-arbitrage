/**
 * SOURCING WORKFLOW item 7 — XLSX export field mapping.
 *
 * Pure, DB/UI-agnostic mapping from an opportunity list row (the shape
 * GET /api/opportunities returns, joined with card/listing/market-reference
 * fields — see apps/worker/src/routes/opportunities.ts's `includeMarketRef`
 * option) to the exact column sets the spec asks for. Kept here rather than
 * in apps/web so the mapping — which fields, in what order, how failure
 * reasons get flattened — is unit-testable without a browser or a DOM
 * environment (this repo's vitest.workspace.ts does not cover apps/web).
 * apps/web only turns these header/row arrays into an actual .xlsx file
 * (via SheetJS) and triggers the download; it adds no business logic.
 *
 * Every column is either a real field already computed by the engine, or an
 * explicit, honest derivation (e.g. "Qualification" is the real `state`,
 * "Failure reasons" is the parsed `qualification_failures` JSON) — nothing
 * here invents a value the data doesn't support. A listing condition the
 * tool never determined exports as the literal string "UNKNOWN", never a
 * blank cell that could be misread as "confirmed no condition issue".
 */

export interface ExportableOpportunityRow {
  strategy: "FLIP" | "GRADE";
  state: string;
  qualification_failures: string | null;

  card_id: string;
  card_name: string;
  card_set_name: string;
  card_number: string;
  card_variant: string;
  card_finish: string;

  listing_id: string;
  listing_title: string;
  listing_item_url: string;
  /** 'FIXED' | 'AUCTION' | 'BEST_OFFER' — the export's "listing category". */
  listing_type: string;
  listing_price: number;
  listing_shipping_cost: number | null;
  listing_item_condition: string | null;
  /** First time this exact eBay listing was observed (ebay_listings.created_at). */
  listing_first_seen: string | null;
  /** Most recent time this exact eBay listing was re-observed (ebay_listings.fetched_at). */
  listing_last_seen: string;

  total_acquisition_cost: number;
  qsv: number | null;
  qsv_basis: string | null;
  /** From the market_snapshot this opportunity was priced against — only
   *  present when the caller asked for `includeMarketRef`. */
  market_median_7d: number | null;
  market_median_30d: number | null;
  market_sample_size: number | null;
  liquidity: string;
  confidence: number;

  expected_net_sale_proceeds: number | null;
  expected_net_profit: number | null;
  return_on_capital: number | null;
  profit_margin: number | null;
  days_to_sale_estimate: number | null;

  // GRADE-only fields — null/absent on FLIP rows, exported anyway on the
  // GRADE sheet (never mixed onto the FLIP sheet's columns).
  grader_id: string | null;
  grading_service_name: string | null;
  total_graded_basis: number | null;
  market_psa7: number | null;
  market_psa8: number | null;
  market_psa9: number | null;
  market_psa10: number | null;
  psa7_profit: number | null;
  psa8_profit: number | null;
  psa9_profit: number | null;
  psa10_profit: number | null;
  break_even_grade: string | null;
  required_psa10_rate_vs_psa9: number | null;
  estimated_capital_lock_days: number | null;
  economic_class: string | null;
}

export type ExportCellValue = string | number | null;

/**
 * `qualification_failures` is stored as a JSON array of QualificationFailure
 * objects (`{ rule, reason }` — see packages/core/src/filters/types.ts), NOT
 * plain reason strings. Bug fixed 2026-09-03 (MWMC V1 FINAL SHIP PASS live
 * verification, same defect as OpportunityTable.tsx's parseReasons): a
 * blind `String(r)` over an object literal renders "[object Object]" —
 * every exported near-miss/rejected row's reasons cell was unreadable
 * before this fix. Flattened to a single semicolon-joined cell — XLSX cells
 * don't do nested structure — but never silently dropped: invalid JSON
 * (should not happen, but this is export code touching stored data) exports
 * the raw text rather than an empty cell that could be misread as
 * "no failure reasons recorded".
 */
export function parseFailureReasons(json: string | null): string {
  if (!json) return "";
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed
        .map((r) => (r && typeof r === "object" && "reason" in r ? String((r as { reason: unknown }).reason) : String(r)))
        .join("; ");
    }
    return String(parsed);
  } catch {
    return json;
  }
}

export const FLIP_EXPORT_HEADERS = [
  "Card ID",
  "Card name",
  "Set",
  "Card number",
  "Variant",
  "Finish",
  "Listing ID",
  "Listing title",
  "Listing URL",
  "Listing category",
  "Listing price (£)",
  "Seller postage (£)",
  "Delivered acquisition cost (£)",
  "Listing condition",
  "QSV (£)",
  "QSV basis",
  "Market 7d median (£)",
  "Market 30d median (£)",
  "Market sample size",
  "Liquidity",
  "Confidence",
  "Expected sale proceeds (£)",
  "Net profit (£)",
  "ROC",
  "Margin",
  "Days to sale (est.)",
  "Qualification",
  "Failure reasons",
  "First seen",
  "Last seen",
] as const;

export function buildFlipExportRow(row: ExportableOpportunityRow): ExportCellValue[] {
  return [
    row.card_id,
    row.card_name,
    row.card_set_name,
    row.card_number,
    row.card_variant,
    row.card_finish,
    row.listing_id,
    row.listing_title,
    row.listing_item_url,
    row.listing_type,
    row.listing_price,
    row.listing_shipping_cost,
    row.total_acquisition_cost,
    row.listing_item_condition ?? "UNKNOWN",
    row.qsv,
    row.qsv_basis,
    row.market_median_7d,
    row.market_median_30d,
    row.market_sample_size,
    row.liquidity,
    row.confidence,
    row.expected_net_sale_proceeds,
    row.expected_net_profit,
    row.return_on_capital,
    row.profit_margin,
    row.days_to_sale_estimate,
    row.state,
    parseFailureReasons(row.qualification_failures),
    row.listing_first_seen,
    row.listing_last_seen,
  ];
}

export const GRADE_EXPORT_HEADERS = [
  ...FLIP_EXPORT_HEADERS,
  "Grader",
  "Grading service",
  "Graded basis (£)",
  "Market PSA7 value (£)",
  "Market PSA8 value (£)",
  "Market PSA9 value (£)",
  "Market PSA10 value (£)",
  "PSA7 profit (£)",
  "PSA8 profit (£)",
  "PSA9 profit (£)",
  "PSA10 profit (£)",
  "Break-even grade",
  "Required PSA10 rate (vs PSA9)",
  "Capital lock (days, est.)",
  "Economic class",
] as const;

export function buildGradeExportRow(row: ExportableOpportunityRow): ExportCellValue[] {
  return [
    ...buildFlipExportRow(row),
    row.grader_id,
    row.grading_service_name,
    row.total_graded_basis,
    row.market_psa7,
    row.market_psa8,
    row.market_psa9,
    row.market_psa10,
    row.psa7_profit,
    row.psa8_profit,
    row.psa9_profit,
    row.psa10_profit,
    row.break_even_grade,
    row.required_psa10_rate_vs_psa9,
    row.estimated_capital_lock_days,
    row.economic_class,
  ];
}

/** Header row + one row per FLIP opportunity, ready for a spreadsheet library. */
export function buildFlipExportSheet(rows: ExportableOpportunityRow[]): ExportCellValue[][] {
  return [Array.from(FLIP_EXPORT_HEADERS), ...rows.map(buildFlipExportRow)];
}

/** Header row + one row per GRADE opportunity, ready for a spreadsheet library. */
export function buildGradeExportSheet(rows: ExportableOpportunityRow[]): ExportCellValue[][] {
  return [Array.from(GRADE_EXPORT_HEADERS), ...rows.map(buildGradeExportRow)];
}
