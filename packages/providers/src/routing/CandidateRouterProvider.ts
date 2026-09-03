/**
 * AI INTELLIGENCE gap 3: selective AI review in the candidate pipeline.
 *
 * WHY THIS EXISTS: after deterministic screening (packages/core's
 * buildOpportunities) and stage-two eBay enrichment (SOURCING WORKFLOW item
 * 9) have already run, some QUALIFIED_FLIP/QUALIFIED_GRADE/INSPECT_PHOTOS
 * candidates are genuinely ambiguous in ways the deterministic engine has
 * no basis to judge — a title/description mismatch, a listing that reads
 * like a lot/bundle despite being priced and searched as a single card, a
 * seller description that contradicts the assumed condition. This is a
 * NARROW, ADDITIONAL triage signal laid on top of an already-qualified
 * candidate — never a replacement for it.
 *
 * Mirrors this codebase's existing provider-interface pattern
 * (AiAdvisoryProvider, QueryInterpreterProvider, ScenarioNarratorProvider)
 * — a caller only ever depends on this interface, never on
 * `AiCandidateRouterProvider` (the real implementation) directly.
 *
 * THE FOUNDING DISCIPLINE, RESTATED: "AI NEVER A SOURCE OF FINANCIAL
 * NUMBERS" (AiModelProvider.ts). `CandidateRouteResponse` below is
 * STRUCTURALLY incapable of violating that — there is no numeric-financial
 * field anywhere on it, only a closed-vocabulary route, a confidence, and a
 * free-text reason. Nothing that calls this interface may use its response
 * for anything other than gating the ACTIONABLE feed (see
 * opportunitiesRepo.ts's applyAiCandidateReview and migration 0021) — it
 * can never create an opportunity, and it can never touch qualifies/QSV/
 * any economics column.
 */
export type CandidateRoute = "PASS_THROUGH" | "REVIEW" | "BLOCK_FROM_ACTIONABLE";

export interface CandidateRouteRequest {
  cardName: string;
  strategy: "FLIP" | "GRADE";
  /** The candidate's own deterministic state (e.g. "QUALIFIED_FLIP",
   *  "INSPECT_PHOTOS") — given as context only; this provider never writes
   *  to or reinterprets it. */
  state: string;
  listingTitle: string;
  listingPrice: number;
  totalAcquisitionCost: number;
  /** Already-computed economics, read-only context — see
   *  buildAdvisoryEconomicsFacts (apps/worker/src/ai/advisoryEvidence.ts).
   *  Never a value this provider is asked to reproduce or validate; unlike
   *  AiListingAnalystProvider's "echo it back" canary, nothing here is
   *  numeric in the response, so there is nothing to contradict. */
  economicsFacts: Record<string, number>;
  /** This app's own engine reasoning for this opportunity (qualification
   *  detail already computed deterministically). */
  reasoning: string[];
  itemCondition?: string | null;
  conditionDescription?: string | null;
  conditionDescriptors?: { name: string; values: string[] }[];
  itemDescription?: string | null;
  aspects?: { name: string; value: string }[];
  sellerFeedbackScore?: number | null;
  sellerFeedbackPct?: number | null;
}

export interface CandidateRouteResponse {
  /** false whenever no trustworthy routing opinion exists — no AI provider
   *  configured, spend/budget cap reached, upstream error, or a guardrail
   *  rejection. Callers MUST check this before reading `route`, and MUST
   *  treat `available: false` the same as `route: "PASS_THROUGH"` (no
   *  opinion is never grounds to block or flag a candidate the
   *  deterministic engine already qualified). */
  available: boolean;
  route: CandidateRoute | null;
  /** The model's own 0-1 confidence in `route`, or null when unavailable. */
  confidence: number | null;
  /** Short, evidence-based explanation for the chosen route — surfaced to
   *  a human, never parsed or acted on programmatically. */
  reason: string | null;
  error: string | null;
}

export interface CandidateRouterProvider {
  readonly name: string;
  routeCandidate(request: CandidateRouteRequest): Promise<CandidateRouteResponse>;
}
