import { describe, it, expect } from "vitest";
import type { OpportunityRow } from "@mwmc/db";
import { buildAdvisoryEconomicsFacts } from "../src/routes/opportunities.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream J.
 *
 * buildAdvisoryEconomicsFacts is what turns an OpportunityRow's own
 * already-computed numbers into the AiListingAnalystProvider's
 * groundTruthFacts (see AiGuardrails.ts, Workstream I) — pins down that
 * it's strategy-conditional (never sends a GRADE-only field on a FLIP row
 * or vice versa, which would be either meaningless or, worse, a stray
 * `null` masquerading as a real fact) and that a genuinely absent figure
 * is left out entirely rather than coerced into a fabricated 0.
 */
function baseRow(overrides: Partial<OpportunityRow>): OpportunityRow {
  return {
    id: "opp-1",
    card_id: "card-1",
    listing_id: "listing-1",
    market_snapshot_id: null,
    scan_run_id: null,
    strategy: "FLIP",
    state: "QUALIFIED_FLIP",
    score: 80,
    qualifies: 1,
    qualification_failures: null,
    identity_confidence: 0.9,
    flip_score: 80,
    grade_score: null,
    listing_price: 38,
    total_acquisition_cost: 42,
    liquidity: "HIGH",
    confidence: 0.9,
    qsv: null,
    qsv_basis: null,
    is_high_confidence_qsv: null,
    buyer_payment: null,
    selling_fees: null,
    expected_net_sale_proceeds: null,
    expected_net_profit: null,
    return_on_capital: null,
    profit_margin: null,
    days_to_sale_estimate: null,
    profit_per_capital_day: null,
    grader_id: null,
    grading_service_id: null,
    grading_service_name: null,
    total_graded_basis: null,
    grade_rungs: null,
    psa6_profit: null,
    psa7_profit: null,
    psa8_profit: null,
    psa9_profit: null,
    psa10_profit: null,
    psa10_value: null,
    break_even_grade: null,
    psa10_upside_multiple: null,
    psa10_gross_multiple: null,
    economic_class: null,
    economic_class_rationale: null,
    required_psa10_rate_vs_psa9: null,
    required_psa10_rate_vs_psa8: null,
    estimated_grading_days: null,
    estimated_capital_lock_days: null,
    annualised_roc_indicator: null,
    potential_upcharge: 0,
    better_velocity_service_id: null,
    reasoning: null,
    review_status: "UNREVIEWED",
    review_notes: null,
    review_reason_code: null,
    reviewed_at: null,
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...overrides,
  } as OpportunityRow;
}

describe("buildAdvisoryEconomicsFacts", () => {
  it("always includes listingPrice and profitPerCapitalDay when present, regardless of strategy", () => {
    const facts = buildAdvisoryEconomicsFacts(baseRow({ strategy: "FLIP", listing_price: 38, profit_per_capital_day: 2.5 }));
    expect(facts.listingPrice).toBe(38);
    expect(facts.profitPerCapitalDay).toBe(2.5);
  });

  it("includes FLIP-specific fields (qsv, expectedNetProfit, profitMargin) for a FLIP row", () => {
    const facts = buildAdvisoryEconomicsFacts(
      baseRow({ strategy: "FLIP", qsv: 62, expected_net_profit: 45.2, profit_margin: 0.35, return_on_capital: 0.8 }),
    );
    expect(facts).toEqual({
      listingPrice: 38,
      returnOnCapital: 0.8,
      qsv: 62,
      expectedNetProfit: 45.2,
      profitMargin: 0.35,
    });
  });

  it("never includes GRADE-only fields on a FLIP row", () => {
    const facts = buildAdvisoryEconomicsFacts(baseRow({ strategy: "FLIP", total_graded_basis: 999, psa9_profit: 999 }));
    expect(facts.totalGradedBasis).toBeUndefined();
    expect(facts.psa9Profit).toBeUndefined();
  });

  it("includes GRADE-specific fields (totalGradedBasis, psa9Profit, psa10Profit) for a GRADE row", () => {
    const facts = buildAdvisoryEconomicsFacts(
      baseRow({ strategy: "GRADE", total_graded_basis: 120, psa9_profit: 60, psa10_profit: 300 }),
    );
    expect(facts.totalGradedBasis).toBe(120);
    expect(facts.psa9Profit).toBe(60);
    expect(facts.psa10Profit).toBe(300);
  });

  it("never includes FLIP-only fields on a GRADE row", () => {
    const facts = buildAdvisoryEconomicsFacts(baseRow({ strategy: "GRADE", qsv: 999, expected_net_profit: 999, profit_margin: 999 }));
    expect(facts.qsv).toBeUndefined();
    expect(facts.expectedNetProfit).toBeUndefined();
    expect(facts.profitMargin).toBeUndefined();
  });

  it("omits a genuinely absent (null) figure entirely — never coerces it to a fabricated 0", () => {
    const facts = buildAdvisoryEconomicsFacts(baseRow({ strategy: "FLIP", qsv: null, expected_net_profit: null }));
    expect("qsv" in facts).toBe(false);
    expect("expectedNetProfit" in facts).toBe(false);
  });
});
