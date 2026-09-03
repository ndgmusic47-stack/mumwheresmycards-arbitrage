/**
 * SOURCING WORKFLOW item 15: "optional AI-advisory interface stub only, no
 * live integration." This file is exactly that — an interface a future AI
 * advisory feature could implement, plus the one implementation that
 * exists today, which does nothing live. No network call, no API key, no
 * model, no Kimi/any-other integration — all explicitly out of scope per
 * this spec's own DO-NOT-DO list ("no AI agent", "no autonomous
 * purchasing", "no Kimi integration yet"). Mirrors this codebase's existing
 * provider-interface pattern (EbayListingsProvider, MarketDataProvider) so
 * that if a future spec authorises a real integration, it's a new class
 * implementing this same interface — nothing that depends on
 * AiAdvisoryProvider needs to change.
 */
export interface AiAdvisoryRequest {
  opportunityId: string;
  cardName: string;
  strategy: "FLIP" | "GRADE";
  listingTitle: string;
  listingPrice: number;
  totalAcquisitionCost: number;
  /** The engine's own already-computed reasoning for this opportunity —
   *  handed to the provider so a future real implementation could use it
   *  as context, not so this stub does anything with it. */
  reasoning: string[];
  /** AI INTELLIGENCE spec Phase 2, Workstream J: every already-computed
   *  numeric economics figure worth grounding a real AI response against —
   *  net profit, ROC, QSV, grade-ladder figures, etc. Strategy-conditional
   *  (FLIP vs GRADE expose different fields; see
   *  `buildAdvisoryEconomicsFacts` in apps/worker/src/routes/opportunities.ts),
   *  built from the SAME OpportunityRow columns the dashboard/detail page
   *  already show — never a number invented for this request. Optional so
   *  existing callers (and NullAiAdvisoryProvider, which never reads it)
   *  don't need updating; a real provider passes it straight through as
   *  AiCompletionRequest.groundTruthFacts (see AiGuardrails.ts,
   *  Workstream I) so a hallucinated restatement of one of these numbers
   *  is caught, not trusted. */
  economicsFacts?: Record<string, number>;
}

export interface AiAdvisoryResponse {
  /** false in every case today. A real implementation would still need to
   *  report this honestly (e.g. a live API outage), so callers must always
   *  check it rather than assuming `summary` is populated whenever the
   *  request succeeds. */
  available: boolean;
  summary: string | null;
  caveats: string[];
}

export interface AiAdvisoryProvider {
  readonly name: string;
  getAdvisory(request: AiAdvisoryRequest): Promise<AiAdvisoryResponse>;
}

/**
 * The only implementation wired up right now. Always reports
 * `available: false` with an explanatory caveat — never a fabricated
 * summary, never a silent no-op that looks like a real answer.
 */
export class NullAiAdvisoryProvider implements AiAdvisoryProvider {
  readonly name = "none";

  async getAdvisory(_request: AiAdvisoryRequest): Promise<AiAdvisoryResponse> {
    return {
      available: false,
      summary: null,
      caveats: ["AI advisory is not connected in this build — this is an interface stub only, per the current spec."],
    };
  }
}
