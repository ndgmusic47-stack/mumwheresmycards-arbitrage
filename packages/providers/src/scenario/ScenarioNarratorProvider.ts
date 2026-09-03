/**
 * AI INTELLIGENCE spec Phase 2, Workstream M: the scenario/what-if engine's
 * optional AI narration layer. Mirrors the exact same shape/discipline as
 * `AiAdvisoryProvider.ts` (Workstream J) — an interface plus an honest
 * always-unavailable stub — for the same reason: so a real implementation
 * (`AiScenarioNarratorProvider`) can be swapped in behind it with no caller
 * change, and so "no AI configured" is never silently indistinguishable
 * from "AI ran and had nothing to say."
 *
 * WHAT THIS IS NOT: a source of numbers. `packages/core/src/calc/
 * scenarioEngine.ts` (`runFlipScenario`/`runGradeScenario`) has ALREADY
 * computed the baseline, the scenario, and every delta by the time anything
 * here is called — this layer's only job is to narrate that already-settled
 * arithmetic in plain English. Every numeric field on
 * `ScenarioNarrationRequest` is ground truth the caller computed, handed in
 * so a real implementation can ground its response against it (see
 * `AiScenarioNarratorProvider`'s own doc comment for the canary-echo
 * mechanism this reuses from Workstream J).
 */
export interface ScenarioNarrationRequest {
  cardName: string;
  strategy: "FLIP" | "GRADE";
  /** Plain-English description of exactly which input(s) changed and by how
   *  much, built by the CALLER from the real override fields actually
   *  applied — e.g. "Total acquisition cost: £100.00 -> £80.00 (QSV
   *  unchanged at £150.00)". Never left for a real implementation to infer
   *  from bare numbers alone, so it can't guess wrong about which side is
   *  "before" and which is "after". */
  changesDescription: string;
  /** A short human label for the single headline economics figure being
   *  compared — e.g. "net profit" (FLIP) or "PSA10 profit" (GRADE). Every
   *  strategy has a different natural headline number; the caller picks it
   *  rather than this layer guessing which of many computed fields matters
   *  most for a given opportunity. */
  keyMetricLabel: string;
  keyMetricBaseline: number;
  keyMetricScenario: number;
  /** Every other already-computed ground-truth figure worth grounding a
   *  real response against — baseline/scenario ROC, margin, per-grade
   *  figures, etc. Strategy-conditional, built by the caller from the
   *  scenario engine's own output, never invented. Optional so a caller
   *  with nothing further to add (and NullScenarioNarratorProvider, which
   *  never reads it) doesn't need to pass an empty object. */
  economicsFacts?: Record<string, number>;
}

export interface ScenarioNarrationResponse {
  /** false whenever no real narration was produced — no key configured,
   *  the daily spend cap was reached, an upstream error, or a guardrail
   *  rejection. Callers must always check this rather than assuming
   *  `summary` is populated whenever the call itself didn't throw. */
  available: boolean;
  summary: string | null;
  caveats: string[];
}

export interface ScenarioNarratorProvider {
  readonly name: string;
  narrateScenario(request: ScenarioNarrationRequest): Promise<ScenarioNarrationResponse>;
}

/**
 * Honest fallback — always reports `available: false` with an explanatory
 * caveat, never a fabricated summary. Not currently wired up anywhere (the
 * worker route builds a real `AiScenarioNarratorProvider` directly, same as
 * every other AI route since Workstream J), but kept as the same safety net
 * `NullAiAdvisoryProvider`/`NullAiModelProvider` are elsewhere in this
 * codebase, in case a future caller needs one without a live model chain.
 */
export class NullScenarioNarratorProvider implements ScenarioNarratorProvider {
  readonly name = "none";

  async narrateScenario(_request: ScenarioNarrationRequest): Promise<ScenarioNarrationResponse> {
    return {
      available: false,
      summary: null,
      caveats: ["Scenario narration is not connected in this build."],
    };
  }
}
