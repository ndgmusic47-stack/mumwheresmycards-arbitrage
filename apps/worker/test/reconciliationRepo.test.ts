import { describe, it, expect } from "vitest";
import type { OpportunityRow } from "@mwmc/db";
import { buildForecastTargets } from "../src/repo/reconciliationRepo.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream N.
 *
 * buildForecastTargets is what turns a frozen `forecast_snapshot` (a full
 * OpportunityRow as it stood at purchase time) into the figures
 * `compareForecastVsRealised` compares a realised trade against. Pins down
 * the central discipline: FLIP compares against the row's own single
 * expected-profit figure, but GRADE compares against the forecast for the
 * SPECIFIC grade this card actually came back as — never a blended
 * "expected value" across grades, and never a fabricated figure when the
 * actual grade has no matching forecast column.
 */
function baseOpportunity(overrides: Partial<OpportunityRow>): OpportunityRow {
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

describe("buildForecastTargets", () => {
  it("returns all-null targets when there is no forecast snapshot at all (never fabricates one)", () => {
    const targets = buildForecastTargets(null, null);
    expect(targets).toEqual({ forecastNetProfit: null, forecastReturnOnCapital: null, forecastCapitalLockDays: null });
  });

  it("FLIP: reads expectedNetProfit/returnOnCapital straight off the snapshot", () => {
    const targets = buildForecastTargets(
      baseOpportunity({ strategy: "FLIP", expected_net_profit: 45.2, return_on_capital: 0.8, estimated_capital_lock_days: 10 }),
      null,
    );
    expect(targets).toEqual({ forecastNetProfit: 45.2, forecastReturnOnCapital: 0.8, forecastCapitalLockDays: 10 });
  });

  it("GRADE: compares against the forecast profit for the SPECIFIC grade actually achieved", () => {
    const snapshot = baseOpportunity({
      strategy: "GRADE",
      total_graded_basis: 120,
      psa9_profit: 60,
      psa10_profit: 300,
      estimated_capital_lock_days: 45,
    });

    const psa9Targets = buildForecastTargets(snapshot, 9);
    expect(psa9Targets.forecastNetProfit).toBe(60);
    expect(psa9Targets.forecastReturnOnCapital).toBeCloseTo(60 / 120, 4);
    expect(psa9Targets.forecastCapitalLockDays).toBe(45);

    const psa10Targets = buildForecastTargets(snapshot, 10);
    expect(psa10Targets.forecastNetProfit).toBe(300);
    expect(psa10Targets.forecastReturnOnCapital).toBeCloseTo(300 / 120, 4);
  });

  it("GRADE: never blends a single 'expected' figure across grades — a different actual grade means a different forecast", () => {
    const snapshot = baseOpportunity({ strategy: "GRADE", total_graded_basis: 120, psa8_profit: -10, psa9_profit: 60 });

    expect(buildForecastTargets(snapshot, 8).forecastNetProfit).toBe(-10);
    expect(buildForecastTargets(snapshot, 9).forecastNetProfit).toBe(60);
  });

  it("GRADE: returns null (never a fabricated figure) when no grade is known yet", () => {
    const snapshot = baseOpportunity({ strategy: "GRADE", total_graded_basis: 120, psa9_profit: 60 });
    const targets = buildForecastTargets(snapshot, null);
    expect(targets.forecastNetProfit).toBeNull();
    expect(targets.forecastReturnOnCapital).toBeNull();
  });

  it("GRADE: returns null when the actual grade is outside PSA_GRADES (e.g. graded below PSA6)", () => {
    const snapshot = baseOpportunity({ strategy: "GRADE", total_graded_basis: 120, psa6_profit: -50 });
    const targets = buildForecastTargets(snapshot, 4);
    expect(targets.forecastNetProfit).toBeNull();
  });

  it("GRADE: returns null when that specific grade's forecast profit was itself null (no market data at forecast time)", () => {
    const snapshot = baseOpportunity({ strategy: "GRADE", total_graded_basis: 120, psa9_profit: null });
    expect(buildForecastTargets(snapshot, 9).forecastNetProfit).toBeNull();
  });

  it("GRADE: returns null ROC (never a fabricated one) when totalGradedBasis is null or zero", () => {
    const snapshot = baseOpportunity({ strategy: "GRADE", total_graded_basis: null, psa9_profit: 60 });
    expect(buildForecastTargets(snapshot, 9).forecastReturnOnCapital).toBeNull();

    const zeroBasis = baseOpportunity({ strategy: "GRADE", total_graded_basis: 0, psa9_profit: 60 });
    expect(buildForecastTargets(zeroBasis, 9).forecastReturnOnCapital).toBeNull();
  });

  it("always carries estimated_capital_lock_days through unchanged, regardless of strategy", () => {
    const flip = buildForecastTargets(baseOpportunity({ strategy: "FLIP", estimated_capital_lock_days: 7 }), null);
    const grade = buildForecastTargets(baseOpportunity({ strategy: "GRADE", estimated_capital_lock_days: 45 }), null);
    expect(flip.forecastCapitalLockDays).toBe(7);
    expect(grade.forecastCapitalLockDays).toBe(45);
  });
});
