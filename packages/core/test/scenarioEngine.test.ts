import { describe, it, expect } from "vitest";
import {
  runFlipScenario,
  runGradeScenario,
  computeFlipProfit,
  computeNetSaleProceeds,
  computeGradeLadder,
  DEFAULT_EXIT_MARKET_FEE_MODEL,
  DEFAULT_SELLING_COSTS,
  DEFAULT_GRADING_SERVICES,
} from "../src/index.js";

const PSA_REGULAR = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_REGULAR")!;

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream M
 * (scenario/what-if engine). The central guarantee this file pins down:
 * `runFlipScenario`/`runGradeScenario` are never a second, parallel
 * implementation of this app's economics — every result they produce must
 * be byte-identical to calling `computeFlipProfit`/`computeGradeLadder`
 * directly with the same effective inputs. Also covers override-merge
 * semantics (a field not mentioned in `overrides` must fall back to the
 * baseline, never a fabricated default) and delta arithmetic.
 */
describe("runFlipScenario", () => {
  const baseline = { totalAcquisitionCost: 100, qsv: 150 };

  it("baseline result matches calling computeFlipProfit directly with the baseline inputs", () => {
    const result = runFlipScenario(baseline, {});
    const sale = computeNetSaleProceeds({ itemPrice: baseline.qsv }, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS);
    const expected = computeFlipProfit({
      totalAcquisitionCost: baseline.totalAcquisitionCost,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
    });
    expect(result.baseline).toEqual(expected);
  });

  it("an empty overrides object produces an identical scenario to the baseline (zero deltas)", () => {
    const result = runFlipScenario(baseline, {});
    expect(result.scenario).toEqual(result.baseline);
    expect(result.delta).toEqual({ netProfit: 0, returnOnCapital: 0, profitMargin: 0 });
  });

  it("overriding only totalAcquisitionCost leaves qsv at its baseline value", () => {
    const result = runFlipScenario(baseline, { totalAcquisitionCost: 80 });
    const sale = computeNetSaleProceeds({ itemPrice: baseline.qsv }, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS);
    const expected = computeFlipProfit({
      totalAcquisitionCost: 80,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
    });
    expect(result.scenario).toEqual(expected);
  });

  it("overriding only qsv leaves totalAcquisitionCost at its baseline value", () => {
    const result = runFlipScenario(baseline, { qsv: 200 });
    const sale = computeNetSaleProceeds({ itemPrice: 200 }, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS);
    const expected = computeFlipProfit({
      totalAcquisitionCost: baseline.totalAcquisitionCost,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
    });
    expect(result.scenario).toEqual(expected);
  });

  it("a lower acquisition cost increases net profit and ROC, reflected correctly in delta", () => {
    const result = runFlipScenario(baseline, { totalAcquisitionCost: 80 });
    expect(result.scenario.netProfit).toBeGreaterThan(result.baseline.netProfit);
    expect(result.delta.netProfit).toBeCloseTo(result.scenario.netProfit - result.baseline.netProfit, 2);
    expect(result.delta.returnOnCapital).toBeCloseTo(result.scenario.returnOnCapital - result.baseline.returnOnCapital, 4);
  });

  it("respects a custom fee model and selling costs, same as computeFlipProfit would", () => {
    const customFeeModel = { ...DEFAULT_EXIT_MARKET_FEE_MODEL, finalValueFeePct: 0.2 };
    const result = runFlipScenario(baseline, {}, customFeeModel, DEFAULT_SELLING_COSTS);
    const sale = computeNetSaleProceeds({ itemPrice: baseline.qsv }, customFeeModel, DEFAULT_SELLING_COSTS);
    const expected = computeFlipProfit({
      totalAcquisitionCost: baseline.totalAcquisitionCost,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
    });
    expect(result.baseline).toEqual(expected);
  });

  // AI INTELLIGENCE gap 4 (business-cost scenario overrides): a
  // scenarioSellingCosts/scenarioFeeModel override must apply ONLY to the
  // scenario side — the baseline must stay computed against the plain
  // feeModel/sellingCosts params, exactly as if the new args were never
  // passed, so a cost-model "what if" never quietly moves the thing it's
  // being compared against.
  it("scenarioSellingCosts overrides only the scenario side, leaving baseline on the production cost model", () => {
    const dearerPostage = { ...DEFAULT_SELLING_COSTS, outboundPostage: DEFAULT_SELLING_COSTS.outboundPostage + 5 };
    const result = runFlipScenario(baseline, {}, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS, undefined, dearerPostage);

    const baselineSale = computeNetSaleProceeds({ itemPrice: baseline.qsv }, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS);
    const expectedBaseline = computeFlipProfit({
      totalAcquisitionCost: baseline.totalAcquisitionCost,
      netSaleProceeds: baselineSale.netProceeds,
      buyerPayment: baselineSale.buyerPayment,
    });
    expect(result.baseline).toEqual(expectedBaseline);

    const scenarioSale = computeNetSaleProceeds({ itemPrice: baseline.qsv }, DEFAULT_EXIT_MARKET_FEE_MODEL, dearerPostage);
    const expectedScenario = computeFlipProfit({
      totalAcquisitionCost: baseline.totalAcquisitionCost,
      netSaleProceeds: scenarioSale.netProceeds,
      buyerPayment: scenarioSale.buyerPayment,
    });
    expect(result.scenario).toEqual(expectedScenario);
    // Dearer postage eats into net proceeds -> strictly lower scenario profit.
    expect(result.scenario.netProfit).toBeLessThan(result.baseline.netProfit);
  });

  it("omitting scenarioFeeModel/scenarioSellingCosts makes both sides use the identical cost model (unchanged default behaviour)", () => {
    const result = runFlipScenario(baseline, { totalAcquisitionCost: 90 });
    // Same call, but this time explicitly passing the SAME feeModel/sellingCosts
    // as the scenario-side override — must be byte-identical either way.
    const withExplicitSameOverrides = runFlipScenario(
      baseline,
      { totalAcquisitionCost: 90 },
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
    );
    expect(result).toEqual(withExplicitSameOverrides);
  });
});

describe("runGradeScenario", () => {
  const baseline = { totalGradedBasis: 200, slabValues: { 6: 80, 7: 150, 8: 300, 9: 600, 10: 2000 } };

  it("baseline ladder matches calling computeGradeLadder directly with the baseline inputs", () => {
    const result = runGradeScenario(baseline, {});
    const expected = computeGradeLadder(
      { totalGradedBasis: baseline.totalGradedBasis, slabValues: baseline.slabValues },
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
    );
    expect(result.baseline).toEqual(expected);
  });

  it("an empty overrides object produces an identical scenario ladder to the baseline", () => {
    const result = runGradeScenario(baseline, {});
    expect(result.scenario).toEqual(result.baseline);
    expect(result.breakEvenGradeChanged).toBe(false);
    expect(result.rungDeltas.every((d) => d.profitDelta === 0)).toBe(true);
  });

  it("overriding a single grade's slab value leaves every other grade's baseline value untouched", () => {
    const result = runGradeScenario(baseline, { slabValues: { 9: 400 } });

    for (const grade of [6, 7, 8, 10] as const) {
      const baseRung = result.baseline.rungs.find((r) => r.grade === grade)!;
      const scenarioRung = result.scenario.rungs.find((r) => r.grade === grade)!;
      expect(scenarioRung.grossSlabValue).toBe(baseRung.grossSlabValue);
    }
    const scenarioPsa9 = result.scenario.rungs.find((r) => r.grade === 9)!;
    expect(scenarioPsa9.grossSlabValue).toBe(400);
  });

  it("overriding totalGradedBasis recomputes profit at every grade against the new basis", () => {
    const result = runGradeScenario(baseline, { totalGradedBasis: 150 });
    for (const grade of [6, 7, 8, 9, 10] as const) {
      const baseRung = result.baseline.rungs.find((r) => r.grade === grade)!;
      const scenarioRung = result.scenario.rungs.find((r) => r.grade === grade)!;
      // Same gross value, cheaper basis -> strictly higher profit at every grade.
      expect(scenarioRung.grossSlabValue).toBe(baseRung.grossSlabValue);
      expect(scenarioRung.profit!).toBeGreaterThan(baseRung.profit!);
    }
  });

  it("computes a correct per-grade profit delta, in PSA_GRADES order", () => {
    const result = runGradeScenario(baseline, { slabValues: { 9: 900 } });
    const psa9Delta = result.rungDeltas.find((d) => d.grade === 9)!;
    const expectedDelta = result.scenario.rungs.find((r) => r.grade === 9)!.profit! - result.baseline.rungs.find((r) => r.grade === 9)!.profit!;
    expect(psa9Delta.profitDelta).toBeCloseTo(expectedDelta, 2);
    expect(result.rungDeltas.map((d) => d.grade)).toEqual([6, 7, 8, 9, 10]);
  });

  it("leaves a grade's delta null when it has no baseline market data, rather than fabricating one", () => {
    const thinBaseline = { totalGradedBasis: 200, slabValues: { 9: 600, 10: 2000 } };
    const result = runGradeScenario(thinBaseline, { slabValues: { 9: 700 } });
    const psa6Delta = result.rungDeltas.find((d) => d.grade === 6)!;
    expect(psa6Delta.profitDelta).toBeNull();
  });

  it("flags breakEvenGradeChanged when a scenario genuinely moves the break-even grade", () => {
    // A basis just above PSA9's net proceeds means baseline break-even is 9;
    // dropping the basis substantially should pull break-even down.
    const thinMargin = { totalGradedBasis: 550, slabValues: { 7: 100, 8: 200, 9: 600, 10: 2000 } };
    const result = runGradeScenario(thinMargin, { totalGradedBasis: 150 });
    expect(result.baseline.breakEvenGrade).not.toBe(result.scenario.breakEvenGrade);
    expect(result.breakEvenGradeChanged).toBe(true);
  });

  it("passes a grading service through to both baseline and scenario computations identically", () => {
    const result = runGradeScenario(baseline, {}, PSA_REGULAR);
    const expected = computeGradeLadder(
      { totalGradedBasis: baseline.totalGradedBasis, slabValues: baseline.slabValues, service: PSA_REGULAR },
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
    );
    expect(result.baseline).toEqual(expected);
  });

  // AI INTELLIGENCE gap 4 (business-cost scenario overrides) — same
  // baseline-untouched guarantee as runFlipScenario's equivalent test.
  it("scenarioSellingCosts overrides only the scenario ladder, leaving baseline on the production cost model", () => {
    const dearerGradedPostage = { ...DEFAULT_SELLING_COSTS, outboundPostageGraded: DEFAULT_SELLING_COSTS.outboundPostageGraded + 8 };
    const result = runGradeScenario(
      baseline,
      {},
      undefined,
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
      undefined,
      undefined,
      dearerGradedPostage,
    );

    const expectedBaseline = computeGradeLadder(
      { totalGradedBasis: baseline.totalGradedBasis, slabValues: baseline.slabValues },
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
    );
    expect(result.baseline).toEqual(expectedBaseline);

    const expectedScenario = computeGradeLadder(
      { totalGradedBasis: baseline.totalGradedBasis, slabValues: baseline.slabValues },
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      dearerGradedPostage,
    );
    expect(result.scenario).toEqual(expectedScenario);

    const baselinePsa10 = result.baseline.rungs.find((r) => r.grade === 10)!.profit!;
    const scenarioPsa10 = result.scenario.rungs.find((r) => r.grade === 10)!.profit!;
    expect(scenarioPsa10).toBeLessThan(baselinePsa10);
  });
});
