/**
 * AI INTELLIGENCE spec Phase 2, Workstream L: natural-language query
 * interpreter.
 *
 * WHY THIS EXISTS: `apps/web/src/state/filters.ts`'s `DashboardFilters` is
 * already the single, validated, allowlisted shape every economics/state
 * filter on the dashboard goes through — a slider or a dropdown never
 * produces anything outside that shape. This feature's entire job is to
 * let a human type something like "grade opportunities under £60 with a
 * PSA10 profit over £200" and have that translated INTO that exact same
 * shape, so it flows through the exact same already-tested filtering
 * pipeline (`buildServerFilterParams`/`applyDashboardFilters`) a manually
 * adjusted slider would. This is deliberately NOT a new query language, a
 * new filter engine, or a path that bypasses qualification — see
 * `InterpretedOpportunityFilters` below, which is a strict, named subset
 * of `DashboardFilters`' own field names/units, never an open-ended shape.
 *
 * Mirrors this codebase's existing provider-interface pattern
 * (AiAdvisoryProvider, MarketDataProvider, EbayListingsProvider) — a
 * caller only ever depends on this interface, never on
 * `AiQueryInterpreterProvider` (the real implementation) directly.
 */
export interface QueryInterpretationRequest {
  /** The user's raw natural-language request, exactly as typed — never
   *  pre-processed or truncated before this point (the caller may cap
   *  length before calling, but doesn't rewrite the text). */
  queryText: string;
}

/**
 * A strict, named subset of `DashboardFilters` (apps/web/src/state/filters.ts)
 * — same field names and units, so a caller can merge this directly onto
 * an existing `DashboardFilters` object with no translation step. Every
 * field is optional: `undefined` means "the query didn't mention this,
 * leave whatever the user already had set unchanged" — never a fabricated
 * default. This is intentionally a SMALLER set than the full
 * `DashboardFilters` shape (the long tail of GRADE-specific grader/service
 * picker fields, for example, are left out) — the fields here are the ones
 * a natural-language query plausibly expresses; the rest stay under manual
 * slider control.
 */
export interface InterpretedOpportunityFilters {
  category?: "ALL" | "ACTIONABLE" | "REVIEW" | "NEAR_MISS" | "REJECTED";
  strategy?: "ALL" | "FLIP" | "GRADE";
  auctionsOnly?: boolean;
  minNetProfit?: number;
  /** Fraction, e.g. 0.4 for "40% ROC" — same unit as DashboardFilters. */
  minReturnOnCapital?: number;
  maxAcquisitionCost?: number;
  minQsv?: number;
  minLiquidity?: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
  /** Fraction 0-1. */
  minConfidence?: number;
  maxTotalGradedBasis?: number;
  minPsa10Profit?: number;
  minPsa9Profit?: number;
  /** Integer PSA grade 1-10. */
  maxBreakEvenGrade?: number;
}

export interface QueryInterpretationResponse {
  /** false whenever no trustworthy interpretation exists — no AI provider
   *  configured, spend cap reached, upstream error. Callers MUST check
   *  this before reading `filters`. */
  available: boolean;
  /** The interpreted filters, or null when `available` is false OR the
   *  query was confidently judged not to be about filtering opportunities
   *  at all (see `caveats` for why, in that second case). */
  filters: InterpretedOpportunityFilters | null;
  /** A short plain-English restatement of what was understood — shown to
   *  the user alongside the applied filters so they can see and correct
   *  what the AI understood, never applied silently with no explanation. */
  explanation: string | null;
  caveats: string[];
}

export interface QueryInterpreterProvider {
  readonly name: string;
  interpretQuery(request: QueryInterpretationRequest): Promise<QueryInterpretationResponse>;
}
