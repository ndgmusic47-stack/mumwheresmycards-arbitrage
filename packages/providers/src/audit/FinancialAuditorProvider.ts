import type { VarianceSummary } from "@mwmc/core";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream N: the AI financial auditor —
 * the first feature in this app to use the AUDIT tier (`AiModelProvider.ts`
 * has named this role since Workstream F: "the financial-auditor/
 * consistency-check role, deliberately kept separate so its own cost/rate
 * budget never competes with routine FAST/DEEP traffic"). Same
 * interface-plus-honest-stub pattern as `AiAdvisoryProvider` (J) and
 * `ScenarioNarratorProvider` (M).
 *
 * WHAT THIS IS NOT: a source of numbers, same discipline as every other AI
 * feature in this app. `summarizeForecastVariance()`
 * (`packages/core/src/realised/varianceSummary.ts`) has ALREADY computed
 * every statistic on `FinancialAuditRequest` by the time anything here is
 * called, from real `ForecastVsRealised` records — this layer's only job is
 * to narrate what those numbers reveal about this app's own track record.
 * Deliberately fed AGGREGATE statistics only, never individual trade rows —
 * a systemic-bias question ("does GRADE consistently underperform its own
 * forecast?") is what aggregates answer; a real implementation has no
 * business claiming to know about one specific trade it was never shown.
 */
export interface FinancialAuditRequest {
  /** Every completed (sold) trade with a forecast to compare against, both
   *  strategies combined — same figure as `overallSummary.sampleSize`,
   *  duplicated here as a plain top-level field so a real implementation
   *  doesn't have to reach into a nested object just to decide how much
   *  weight the sample deserves. */
  sampleSize: number;
  overallSummary: VarianceSummary;
  /** Present only when at least one FLIP trade has a forecast to compare
   *  against — omitted (never a fabricated all-null summary) when there
   *  are none yet. */
  flipSummary?: VarianceSummary;
  gradeSummary?: VarianceSummary;
}

export interface FinancialAuditResponse {
  /** false whenever no real audit narration was produced — no key
   *  configured, the daily spend cap was reached, an upstream error, or a
   *  guardrail rejection. Callers must always check this rather than
   *  assuming `summary` is populated whenever the call itself didn't
   *  throw. */
  available: boolean;
  summary: string | null;
  caveats: string[];
}

export interface FinancialAuditorProvider {
  readonly name: string;
  auditPerformance(request: FinancialAuditRequest): Promise<FinancialAuditResponse>;
}

/**
 * Honest fallback — always reports `available: false` with an explanatory
 * caveat, never a fabricated summary. Not currently wired up anywhere (the
 * worker route builds a real `AiFinancialAuditorProvider` directly, same as
 * every other AI route since Workstream J), kept for the same reason
 * `NullScenarioNarratorProvider`/`NullAiAdvisoryProvider` are.
 */
export class NullFinancialAuditorProvider implements FinancialAuditorProvider {
  readonly name = "none";

  async auditPerformance(_request: FinancialAuditRequest): Promise<FinancialAuditResponse> {
    return {
      available: false,
      summary: null,
      caveats: ["Financial audit narration is not connected in this build."],
    };
  }
}
