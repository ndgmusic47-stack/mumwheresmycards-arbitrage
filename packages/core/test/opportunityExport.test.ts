import { describe, expect, it } from "vitest";
import {
  buildFlipExportRow,
  buildGradeExportRow,
  buildFlipExportSheet,
  buildGradeExportSheet,
  parseFailureReasons,
  FLIP_EXPORT_HEADERS,
  GRADE_EXPORT_HEADERS,
  type ExportableOpportunityRow,
} from "../src/export/opportunityExport.js";

function baseRow(overrides: Partial<ExportableOpportunityRow> = {}): ExportableOpportunityRow {
  return {
    strategy: "FLIP",
    state: "QUALIFIED_FLIP",
    qualification_failures: null,
    card_id: "card-1",
    card_name: "Charizard",
    card_set_name: "Base Set",
    card_number: "4/102",
    card_variant: "Holo",
    card_finish: "Holo",
    listing_id: "listing-1",
    listing_title: "Charizard Base Set Holo NM",
    listing_item_url: "https://ebay.co.uk/itm/123",
    listing_type: "FIXED",
    listing_price: 100,
    listing_shipping_cost: 4.5,
    listing_item_condition: "New",
    listing_first_seen: "2026-09-01T10:00:00Z",
    listing_last_seen: "2026-09-02T10:00:00Z",
    total_acquisition_cost: 104.5,
    qsv: 150,
    qsv_basis: "SOLD_MEDIAN_7D",
    market_median_7d: 152,
    market_median_30d: 148,
    market_sample_size: 12,
    liquidity: "HIGH",
    confidence: 0.8,
    expected_net_sale_proceeds: 140,
    expected_net_profit: 35.5,
    return_on_capital: 0.34,
    profit_margin: 0.25,
    days_to_sale_estimate: 14,
    grader_id: null,
    grading_service_name: null,
    total_graded_basis: null,
    market_psa7: null,
    market_psa8: null,
    market_psa9: null,
    market_psa10: null,
    psa7_profit: null,
    psa8_profit: null,
    psa9_profit: null,
    psa10_profit: null,
    break_even_grade: null,
    required_psa10_rate_vs_psa9: null,
    estimated_capital_lock_days: null,
    economic_class: null,
    ...overrides,
  };
}

describe("parseFailureReasons", () => {
  it("returns an empty string for null", () => {
    expect(parseFailureReasons(null)).toBe("");
  });

  it("joins a JSON array of reasons with semicolons", () => {
    expect(parseFailureReasons(JSON.stringify(["below profit threshold", "low liquidity"]))).toBe(
      "below profit threshold; low liquidity",
    );
  });

  it("falls back to the raw text on invalid JSON rather than dropping it", () => {
    expect(parseFailureReasons("not json")).toBe("not json");
  });

  it("stringifies a non-array JSON value rather than throwing", () => {
    expect(parseFailureReasons(JSON.stringify("single reason"))).toBe("single reason");
  });
});

describe("buildFlipExportRow", () => {
  it("maps every FLIP field in the documented header order", () => {
    const row = buildFlipExportRow(baseRow());
    expect(row).toHaveLength(FLIP_EXPORT_HEADERS.length);
    expect(row[0]).toBe("card-1"); // Card ID
    expect(row[6]).toBe("listing-1"); // Listing ID
    expect(row[12]).toBe(104.5); // Delivered acquisition cost
    expect(row[25]).toBe(14); // Days to sale
    expect(row[26]).toBe("QUALIFIED_FLIP"); // Qualification
    expect(row[27]).toBe(""); // Failure reasons (none)
    expect(row[28]).toBe("2026-09-01T10:00:00Z"); // First seen
    expect(row[29]).toBe("2026-09-02T10:00:00Z"); // Last seen
  });

  it("exports UNKNOWN, never a blank cell, when listing condition was never determined", () => {
    const row = buildFlipExportRow(baseRow({ listing_item_condition: null }));
    const conditionIndex = FLIP_EXPORT_HEADERS.indexOf("Listing condition");
    expect(row[conditionIndex]).toBe("UNKNOWN");
  });

  it("surfaces parsed failure reasons for a non-qualifying row", () => {
    const row = buildFlipExportRow(
      baseRow({
        state: "WATCH",
        qualification_failures: JSON.stringify(["below profit threshold", "below ROC threshold"]),
      }),
    );
    const reasonsIndex = FLIP_EXPORT_HEADERS.indexOf("Failure reasons");
    expect(row[reasonsIndex]).toBe("below profit threshold; below ROC threshold");
  });
});

describe("buildGradeExportRow", () => {
  it("includes every FLIP column plus the GRADE-only columns, in order", () => {
    const row = buildGradeExportRow(
      baseRow({
        strategy: "GRADE",
        grader_id: "psa",
        grading_service_name: "PSA Regular",
        total_graded_basis: 130,
        market_psa7: 120,
        market_psa8: 180,
        market_psa9: 260,
        market_psa10: 500,
        psa7_profit: -10,
        psa8_profit: 20,
        psa9_profit: 90,
        psa10_profit: 300,
        break_even_grade: "8",
        required_psa10_rate_vs_psa9: 0.15,
        estimated_capital_lock_days: 95,
        economic_class: "ASYMMETRIC",
      }),
    );
    expect(row).toHaveLength(GRADE_EXPORT_HEADERS.length);
    expect(GRADE_EXPORT_HEADERS.slice(0, FLIP_EXPORT_HEADERS.length)).toEqual(FLIP_EXPORT_HEADERS);
    const graderIndex = GRADE_EXPORT_HEADERS.indexOf("Grader");
    expect(row[graderIndex]).toBe("psa");
    const psa10ProfitIndex = GRADE_EXPORT_HEADERS.indexOf("PSA10 profit (£)");
    expect(row[psa10ProfitIndex]).toBe(300);
    const economicClassIndex = GRADE_EXPORT_HEADERS.indexOf("Economic class");
    expect(row[economicClassIndex]).toBe("ASYMMETRIC");
  });
});

describe("buildFlipExportSheet / buildGradeExportSheet", () => {
  it("puts the header row first, then one row per opportunity", () => {
    const sheet = buildFlipExportSheet([baseRow(), baseRow({ card_id: "card-2" })]);
    expect(sheet).toHaveLength(3);
    expect(sheet[0]).toEqual(Array.from(FLIP_EXPORT_HEADERS));
    expect(sheet[1][0]).toBe("card-1");
    expect(sheet[2][0]).toBe("card-2");
  });

  it("builds an empty-but-headered sheet for zero rows, never omitting the header", () => {
    expect(buildGradeExportSheet([])).toEqual([Array.from(GRADE_EXPORT_HEADERS)]);
  });
});
