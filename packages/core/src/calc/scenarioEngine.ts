import type { ExitMarketFeeModel } from "./fees.js";
import { round2, round4, DEFAULT_EXIT_MARKET_FEE_MODEL } from "./fees.js";
import type { SellingCostSettings, PsaGrade, GradingService, FlipProfitResult, GradeLadderResult } from "./types.js";
import { DEFAULT_SELLING_COSTS } from "./types.js";
import { computeNetSaleProceeds } from "./netSaleProceeds.js";
import { computeFlipProfit } from "./flipProfit.js";
import { computeGradeLadder } from "./gradeLadder.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream M: the scenario/what-if engine.
 *
 * WHY THIS IS DELIBERATELY NOT AN "AI" FEATURE ITSELF: this app's founding
 * discipline (`AiModelProvider.ts`, since Workstream F) is "NEVER A SOURCE
 * OF FINANCIAL NUMBERS" — the deterministic engine computes economics, AI
 * is only ever handed the result as read-only context to narrate over
 * (Workstream J) or interpret a request against (Workstream L). A "what if
 * I paid £20 less" or "what if this only grades PSA8" question is
 * ARITHMETIC, not judgement — so this file answers it with the EXACT SAME
 * calculators the real opportunity engine uses
 * (`computeNetSaleProceeds`/`computeFlipProfit`/`computeGradeLadder`),
 * called twice — once with the opportunity's real baseline inputs, once
 * with the user's hypothetical overrides substituted in — never a
 * parallel, second implementation of this app's economics. The optional
 * AI layer that sits on top of this (`packages/providers/src/scenario/`)
 * only ever narrates the two computed results this file produces; it
 * still never computes anything itself.
 *
 * Every override is OPTIONAL and defaults to the baseline value — a
 * caller only sets the field(s) actually being asked "what if" about, so
 * "what if QSV were higher, other things equal" doesn't accidentally also
 * change the acquisition cost via some unrelated stale default.
 *
 * AI INTELLIGENCE gap 4 (financial engineering — business-cost scenario
 * overrides): both run*Scenario functions also accept an OPTIONAL
 * `scenarioFeeModel`/`scenarioSellingCosts` pair, applied ONLY to the
 * "scenario" side's computation while "baseline" always keeps using the
 * plain `feeModel`/`sellingCosts` params (live production settings, as
 * loaded by the caller). This is what lets a caller ask "what if postage
 * cost £1 more, other things equal" without that hypothetical also quietly
 * changing the baseline it's being compared against — the same "override
 * only what's being asked about" discipline the FLIP/GRADE input overrides
 * above already follow, extended to the cost-model side. Omitting them
 * (the default) makes both sides use the exact same cost model, matching
 * every existing caller's behaviour unchanged.
 */

// ---------------------------------------------------------------------------
// FLIP
// ---------------------------------------------------------------------------

export interface FlipScenarioInput {
  totalAcquisitionCost: number;
  /** The reference sale price — QSV, in this app's real usage. */
  qsv: number;
  buyerPaidShipping?: number;
}

export interface FlipScenarioDelta {
  netProfit: number;
  /** Fraction, same unit as FlipProfitResult.returnOnCapital. */
  returnOnCapital: number;
  /** Fraction, same unit as FlipProfitResult.profitMargin. */
  profitMargin: number;
}

export interface FlipScenarioResult {
  baseline: FlipProfitResult;
  scenario: FlipProfitResult;
  delta: FlipScenarioDelta;
}

/**
 * Recomputes FLIP economics once for `baseline` and once for `baseline`
 * with `overrides` merged on top, via the identical
 * computeNetSaleProceeds -> computeFlipProfit pathway
 * `packages/core/src/opportunity/engine.ts` uses for a real listing.
 */
export function runFlipScenario(
  baseline: FlipScenarioInput,
  overrides: Partial<FlipScenarioInput>,
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
  sellingCosts: SellingCostSettings = DEFAULT_SELLING_COSTS,
  scenarioFeeModel?: ExitMarketFeeModel,
  scenarioSellingCosts?: SellingCostSettings,
): FlipScenarioResult {
  const scenarioInput: FlipScenarioInput = { ...baseline, ...overrides };

  const computeFor = (
    input: FlipScenarioInput,
    forFeeModel: ExitMarketFeeModel,
    forSellingCosts: SellingCostSettings,
  ): FlipProfitResult => {
    const sale = computeNetSaleProceeds(
      { itemPrice: input.qsv, buyerPaidShipping: input.buyerPaidShipping },
      forFeeModel,
      forSellingCosts,
    );
    return computeFlipProfit({
      totalAcquisitionCost: input.totalAcquisitionCost,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
    });
  };

  const baselineResult = computeFor(baseline, feeModel, sellingCosts);
  const scenarioResult = computeFor(scenarioInput, scenarioFeeModel ?? feeModel, scenarioSellingCosts ?? sellingCosts);

  return {
    baseline: baselineResult,
    scenario: scenarioResult,
    delta: {
      netProfit: round2(scenarioResult.netProfit - baselineResult.netProfit),
      returnOnCapital: round4(scenarioResult.returnOnCapital - baselineResult.returnOnCapital),
      profitMargin: round4(scenarioResult.profitMargin - baselineResult.profitMargin),
    },
  };
}

// ---------------------------------------------------------------------------
// GRADE
// ---------------------------------------------------------------------------

export interface GradeScenarioInput {
  totalGradedBasis: number;
  /** Gross slab market value at each grade, in GBP — same shape
   *  computeGradeLadder itself takes (PSA_GRADES = 6-10). */
  slabValues: Partial<Record<PsaGrade, number | null>>;
}

export interface GradeScenarioOverrides {
  totalGradedBasis?: number;
  /** Merged PER-GRADE onto baseline.slabValues — a grade not mentioned
   *  here keeps its baseline value, so "what if only PSA9 dropped to £80"
   *  doesn't also blank out every other grade's real market value. */
  slabValues?: Partial<Record<PsaGrade, number | null>>;
}

export interface GradeScenarioRungDelta {
  grade: PsaGrade;
  /** null when either side has no value at this grade — never a
   *  fabricated delta against a missing comp. */
  profitDelta: number | null;
}

export interface GradeScenarioResult {
  baseline: GradeLadderResult;
  scenario: GradeLadderResult;
  /** Per-grade profit delta, same PSA_GRADES order as both ladders. */
  rungDeltas: GradeScenarioRungDelta[];
  breakEvenGradeChanged: boolean;
}

/**
 * Recomputes the full GRADE ladder once for `baseline` and once with
 * `overrides` merged on top, via the identical `computeGradeLadder` this
 * app's real opportunity engine uses.
 */
export function runGradeScenario(
  baseline: GradeScenarioInput,
  overrides: GradeScenarioOverrides,
  service?: GradingService,
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
  sellingCosts: SellingCostSettings = DEFAULT_SELLING_COSTS,
  usdPerGbp?: number,
  scenarioFeeModel?: ExitMarketFeeModel,
  scenarioSellingCosts?: SellingCostSettings,
): GradeScenarioResult {
  const scenarioInput: GradeScenarioInput = {
    totalGradedBasis: overrides.totalGradedBasis ?? baseline.totalGradedBasis,
    slabValues: { ...baseline.slabValues, ...overrides.slabValues },
  };

  const computeFor = (
    input: GradeScenarioInput,
    forFeeModel: ExitMarketFeeModel,
    forSellingCosts: SellingCostSettings,
  ): GradeLadderResult =>
    computeGradeLadder(
      { totalGradedBasis: input.totalGradedBasis, slabValues: input.slabValues, service, usdPerGbp },
      forFeeModel,
      forSellingCosts,
    );

  const baselineResult = computeFor(baseline, feeModel, sellingCosts);
  const scenarioResult = computeFor(scenarioInput, scenarioFeeModel ?? feeModel, scenarioSellingCosts ?? sellingCosts);

  const rungDeltas: GradeScenarioRungDelta[] = baselineResult.rungs.map((baseRung, i) => {
    const scenarioRung = scenarioResult.rungs[i]!;
    const profitDelta =
      baseRung.profit !== null && scenarioRung.profit !== null ? round2(scenarioRung.profit - baseRung.profit) : null;
    return { grade: baseRung.grade, profitDelta };
  });

  return {
    baseline: baselineResult,
    scenario: scenarioResult,
    rungDeltas,
    breakEvenGradeChanged: baselineResult.breakEvenGrade !== scenarioResult.breakEvenGrade,
  };
}
