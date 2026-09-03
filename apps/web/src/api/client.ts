import type { FlipScenarioResult, GradeScenarioResult, VarianceSummary, ForecastVsRealised } from "@mwmc/core";

const API_BASE = "/arbitrage/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${path} failed: ${response.status} ${body}`);
  }
  return response.json() as Promise<T>;
}

export interface OpportunityListItem {
  id: string;
  card_id: string;
  listing_id: string;
  strategy: "FLIP" | "GRADE";
  state: string;
  /** 0-100 RANKING score. Never decides qualification — see economics below. */
  score: number | null;
  /** 1 when this cleared the economic bar. Economics qualify, score ranks. */
  qualifies: number;
  qualification_failures: string | null; // json array
  flip_score: number | null;
  grade_score: number | null;
  identity_confidence: number | null;

  listing_price: number;
  total_acquisition_cost: number;
  liquidity: string;
  confidence: number;

  // ---- FLIP ----
  qsv: number | null;
  qsv_basis: string | null;
  is_high_confidence_qsv: number | null;
  buyer_payment: number | null;
  selling_fees: number | null;
  expected_net_sale_proceeds: number | null;
  expected_net_profit: number | null;
  return_on_capital: number | null;
  profit_margin: number | null;
  days_to_sale_estimate: number | null;
  profit_per_capital_day: number | null;

  // ---- GRADE ----
  grader_id: string | null;
  grading_service_id: string | null;
  grading_service_name: string | null;
  total_graded_basis: number | null;
  grade_rungs: string | null; // json: full ladder, all five grades
  psa6_profit: number | null;
  psa7_profit: number | null;
  psa8_profit: number | null;
  psa9_profit: number | null;
  psa10_profit: number | null;
  psa10_value: number | null;
  break_even_grade: string | null;
  psa10_gross_multiple: number | null;
  economic_class: string | null;
  economic_class_rationale: string | null;
  required_psa10_rate_vs_psa9: number | null;
  required_psa10_rate_vs_psa8: number | null;
  estimated_grading_days: number | null;
  estimated_capital_lock_days: number | null;
  annualised_roc_indicator: number | null;
  potential_upcharge: number | null;
  better_velocity_service_id: string | null;

  card_name: string;
  card_set_name: string;
  card_set_code: string;
  card_number: string;
  card_edition: string;
  card_variant: string;
  card_finish: string;
  listing_title: string;
  listing_item_url: string;
  listing_type: string;
  listing_item_condition: string | null;
  listing_status: string;
  listing_fetched_at: string;
  /** SOURCING WORKFLOW item 14 — bid count / auction end time, always
   *  selected now (cheap, same already-joined ebay_listings row); null on
   *  a non-AUCTION listing since eBay never sets these for one. */
  listing_bids: number | null;
  listing_end_time: string | null;
  /** SOURCING WORKFLOW item 7 (XLSX export) — always present. */
  listing_shipping_cost: number;
  listing_first_seen: string;
  /** SOURCING WORKFLOW item 9 (two-stage enrichment) — null means this
   *  listing has never been through the stage-two "Get Item" call (see
   *  scanRunner.ts); non-null timestamp means it has. The raw condition
   *  descriptors themselves live on the opportunity detail endpoint, not
   *  here — this is just enough to show an "enriched" signal in the list. */
  listing_enriched_at: string | null;
  /** SOURCING WORKFLOW item 17 (review-status workflow) — a manual sourcing
   *  decision recorded against this opportunity, independent of state/
   *  qualifies/score. Always present (defaults to 'UNREVIEWED' for every
   *  opportunity, including ones that predate this feature). */
  review_status: "UNREVIEWED" | "CHECKED" | "INTERESTED" | "PASS" | "BOUGHT";
  review_notes: string | null;
  reviewed_at: string | null;
  /** SOURCING WORKFLOW item 7/11 — only present when the request passed
   *  `includeMarketRef: true` (see OpportunityQueryParams); undefined
   *  otherwise, never a fabricated null standing in for "didn't ask". */
  market_median_7d?: number | null;
  market_median_30d?: number | null;
  market_sample_size?: number | null;
  market_psa7?: number | null;
  market_psa8?: number | null;
  market_psa9?: number | null;
  market_psa10?: number | null;
  /** SOURCING WORKFLOW item 14 — the highest bid (before postage/tax/fees)
   *  that would still clear the live qualification bar, computed fresh on
   *  every request. FLIP-strategy rows only — null on every GRADE row, not
   *  a fabricated figure (see computeMaxBid in @mwmc/core). */
  max_bid: number | null;
  max_delivered_cost: number | null;
  /** max_bid minus the current listing_price. Negative means the current
   *  price already exceeds what the economics support — never shown as if
   *  it were positive headroom. */
  headroom_vs_current_price: number | null;
}

/** One rung of the grade ladder, as stored in `grade_rungs`. */
export interface GradeRung {
  grade: number;
  grossSlabValue: number | null;
  sellingFees: number | null;
  netProceeds: number | null;
  profit: number | null;
  returnOnCapital: number | null;
  potentialUpcharge: boolean;
}

export interface OpportunityCounts {
  totalCandidates: number;
  qualifiedFlip: number;
  qualifiedGrade: number;
  inspectPhotos: number;
  qualifiedTotal: number;
  watch: number;
  noMarketData: number;
  identityUncertain: number;
  computationError: number;
  auctions: number;
  endedListings: number;
  byState: Record<string, number>;
}

/** SOURCING WORKFLOW item 5's allowlisted sort keys — kept in sync with
 *  SORT_EXPRESSIONS in apps/worker/src/routes/opportunities.ts by hand (a
 *  string union here, not a shared import, since the web and worker
 *  packages don't share runtime code — see opportunitiesSortAndFilters.test.ts
 *  for the server-side contract this must match). */
export type OpportunitySortKey =
  | "newest"
  | "score"
  | "listing_price"
  | "delivered_cost"
  | "qsv"
  | "discount_to_qsv"
  | "net_profit"
  | "roc"
  | "margin"
  | "liquidity"
  | "confidence"
  | "card_name"
  | "last_scan"
  | "psa9_profit"
  | "psa10_profit"
  | "break_even_grade"
  | "graded_basis"
  | "capital_lock"
  | "current_bid"
  | "time_remaining";

export interface OpportunityQueryParams {
  strategy?: string;
  state?: string;
  limit?: number;
  offset?: number;
  /** 1-based. Wins over `offset` if both are set — mirrors the server. */
  page?: number;
  qualifiedOnly?: boolean;
  sort?: OpportunitySortKey;
  dir?: "asc" | "desc";
  // SOURCING WORKFLOW item 6 — server-side range/set filters. Only the
  // fields wired here actually leave the browser; anything not listed
  // (the fine-grained GRADE filters) is still applied client-side against
  // whatever page is loaded — see Dashboard.tsx's comment on that split.
  minListingPrice?: number;
  maxListingPrice?: number;
  minDeliveredCost?: number;
  maxDeliveredCost?: number;
  minQsv?: number;
  maxQsv?: number;
  minNetProfit?: number;
  minRoc?: number;
  minDiscountToQsv?: number;
  minConfidence?: number;
  minCapitalLock?: number;
  maxCapitalLock?: number;
  liquidity?: string; // comma-separated
  listingType?: string; // comma-separated
  condition?: string; // comma-separated, "UNKNOWN" sentinel supported
  cardName?: string;
  set?: string;
  /** SOURCING WORKFLOW item 7/11 — ask the server to also join market_snapshots
   *  for the reference-price columns (7d/30d median, PSA7-10 values). Not
   *  set on the normal paginated dashboard fetch — only the XLSX export flow
   *  (and, later, the "why is this cheap?" panel) needs the extra JOIN. */
  includeMarketRef?: boolean;
}

export function fetchOpportunities(params: OpportunityQueryParams = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === null) continue;
    qs.set(key, String(value));
  }
  if (params.strategy === "ALL") qs.delete("strategy");
  const query = qs.toString();
  return request<{
    opportunities: OpportunityListItem[];
    total: number;
    limit: number;
    offset: number;
    page: number;
    pageCount: number;
    counts: OpportunityCounts;
  }>(`/opportunities${query ? `?${query}` : ""}`);
}

/** SOURCING WORKFLOW item 7 (XLSX export): fetch every row matching the
 *  current filter/sort/state — not just the current 75-row page — in one
 *  call, with market-reference columns joined in. Mirrors the server's own
 *  export ceiling (see the comment on `rawLimit` in
 *  apps/worker/src/routes/opportunities.ts) rather than re-deriving a
 *  different number here; if the matching set ever exceeds that ceiling,
 *  `total` in the response will be larger than `opportunities.length` and
 *  the caller is expected to say so rather than silently exporting a
 *  truncated file as if it were complete.
 */
export function fetchOpportunitiesForExport(params: Omit<OpportunityQueryParams, "limit" | "offset" | "page"> = {}) {
  return fetchOpportunities({ ...params, limit: 5000, page: 1, includeMarketRef: true });
}

/** SOURCING WORKFLOW item 8: PokeTrace's real per-condition raw-card
 *  pricing, extracted server-side from the linked market_snapshot's stored
 *  raw_payload (see extractConditionTierPrices in @mwmc/core) — null when
 *  no market snapshot is linked, or the payload had no recognisable prices
 *  object. `source` names which PokeTrace price source (e.g. "ebay",
 *  "tcgplayer") these came from. */
export interface ConditionTierPrices {
  damaged: number | null;
  heavilyPlayed: number | null;
  moderatelyPlayed: number | null;
  lightlyPlayed: number | null;
  nearMint: number | null;
  source: string | null;
}

export function fetchOpportunityDetail(id: string) {
  return request<{
    opportunity: any;
    card: any;
    listing: any;
    marketSnapshot: any;
    conditionTierPrices: ConditionTierPrices | null;
    reasoning: string[];
  }>(`/opportunities/${id}`);
}

/** SOURCING WORKFLOW item 15 built this fetched-on-demand (button click,
 *  never on page load — see the worker route's own doc comment). AI
 *  INTELLIGENCE spec Phase 2, Workstream J wired a real provider in behind
 *  the exact same response shape — `advisory.available` can now genuinely
 *  be true, with a real `summary`/`caveats`, whenever OPENAI_API_KEY is
 *  configured; it stays honestly `false` (no client change needed either
 *  way) when no key is set, the daily spend cap is reached, or the
 *  hallucination guardrail rejected a response. `providerName` is always
 *  `"listing-analyst"` now (that class itself never changes — only
 *  whether the AI chain it wraps is genuinely connected does), so check
 *  `advisory.available` for connectivity, not this field; it's kept for
 *  logging/debugging only. */
export function fetchOpportunityAdvisory(id: string) {
  return request<{
    advisory: { available: boolean; summary: string | null; caveats: string[] };
    providerName: string;
  }>(`/opportunities/${id}/advisory`);
}

export type ReviewStatus = "UNREVIEWED" | "CHECKED" | "INTERESTED" | "PASS" | "BOUGHT";

/** SOURCING WORKFLOW item 17: either field may be omitted to update only
 *  the other — see the worker route's own doc comment. */
export function updateOpportunityReview(id: string, update: { reviewStatus?: ReviewStatus; reviewNotes?: string }) {
  return request<{ opportunity: any }>(`/opportunities/${id}/review`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

export function fetchInventory(status?: string) {
  const qs = status ? `?status=${status}` : "";
  return request<{ inventory: any[] }>(`/inventory${qs}`);
}

export interface ScanRunSummary {
  id: string;
  trigger: "CRON" | "MANUAL";
  status: "RUNNING" | "SUCCESS" | "FAILED" | "PARTIAL";
  listings_fetched: number;
  market_snapshots_fetched: number;
  opportunities_created: number;
  opportunities_updated: number;
  api_calls_made: number;
  /** JSON-encoded string[] of non-fatal errors collected during the run, or
   *  null if none. Individual step failures (catalogue sync, a single
   *  card's eBay search, market profiling) are caught and logged here
   *  rather than aborting the whole scan — see apps/worker/src/scan/scanRunner.ts. */
  errors: string | null;
}

export function fetchScanRuns() {
  return request<{ scanRuns: ScanRunSummary[] }>(`/scan-runs`);
}

export function triggerScan() {
  return request<{
    scanRun: ScanRunSummary;
    cardsProfiledThisRun: number;
    cardsSearchedThisRun: number;
    ebayApiCallsThisRun: number;
    duplicateListingsThisRun: number;
    /** SOURCING WORKFLOW item 9 — listings that got a stage-two "Get Item"
     *  enrichment call this run (see scanRunner.ts). */
    enrichedListingsThisRun: number;
  }>(`/scan-runs`, {
    method: "POST",
  });
}

export function fetchSettings() {
  return request<any>(`/settings`);
}

export interface MarketSummary {
  cardsIndexed: number;
  cardsWithMarketData: number;
  cardsProfiled: number;
  dynamicGradeCandidates: number;
  dynamicFlipMarkets: number;
  ebayListingsScanned: number;
  liveOpportunities: number;
}

export function fetchMarketSummary() {
  return request<MarketSummary>(`/market/summary`);
}

export interface ScanCoverageStats {
  eligibleUniverseSize: number;
  neverSearched: number;
  searchedRecently: number;
  oldestSearchedAgeHours: number | null;
}

export function fetchScanCoverage() {
  return request<ScanCoverageStats>(`/market/coverage`);
}

/** SOURCING WORKFLOW task #53: matches routes/market.ts's MARKET_SORT_EXPRESSIONS
 *  keys exactly — an unrecognised key is safely ignored server-side (falls
 *  back to the combined-score default), so this type is documentation, not
 *  a hard runtime contract. */
export type MarketSortKey =
  | "name"
  | "raw_market_value"
  | "qsv"
  | "psa8"
  | "psa9"
  | "psa10"
  | "flip_score"
  | "grade_score"
  | "break_even_grade"
  | "capital_lock"
  | "last_scanned";

export interface MarketCardFilters {
  rawMin?: number;
  rawMax?: number;
  psa8Min?: number;
  psa9Min?: number;
  psa10Min?: number;
  breakEvenMax?: number;
  gradeScoreMin?: number;
  flipScoreMin?: number;
  liquidityMin?: string;
  confidenceMin?: number;
  rawSalesMin?: number;
  set?: string;
  name?: string;
  variant?: string;
  strategy?: "FLIP" | "GRADE";
  limit?: number;
  offset?: number;
  /** 1-based; wins over `offset` when both are set — same convention as
   *  GET /api/opportunities. */
  page?: number;
  sort?: MarketSortKey;
  dir?: "asc" | "desc";
}

export interface MarketCardItem {
  id: string;
  name: string;
  set_name: string;
  set_code: string;
  card_number: string;
  year: number | null;
  edition: string;
  variant: string;
  finish: string;
  rarity: string | null;
  last_ebay_scanned_at: string | null;
  raw_market_value: number | null;
  conservative_qsv: number | null;
  flip_liquidity: string | null;
  flip_confidence: number | null;
  max_profitable_acquisition_price: number | null;
  flip_eligible: number | null;
  flip_market_score: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  break_even_grade: number | null;
  psa10_upside_multiple: number | null;
  psa10_gross_multiple: number | null;
  economic_class: string | null;
  economic_class_rationale: string | null;
  required_psa10_rate_vs_psa9: number | null;
  reference_service_id: string | null;
  estimated_capital_lock_days: number | null;
  qsv_basis: string | null;
  is_high_confidence_qsv: number | null;
  grade_liquidity: string | null;
  grade_confidence: number | null;
  grade_eligible: number | null;
  grade_market_score: number | null;
}

export function fetchMarketCards(filters: MarketCardFilters = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  const query = qs.toString();
  return request<{ cards: MarketCardItem[]; total: number; limit: number; offset: number; page: number; pageCount: number }>(
    `/market${query ? `?${query}` : ""}`,
  );
}

export function fetchCatalogueStatus() {
  return request<{ checkpoint: any; runs: any[] }>(`/catalogue/status`);
}

export function triggerCatalogueSync() {
  return request<{ syncRun: any }>(`/catalogue/sync`, { method: "POST" });
}

export interface SyncAndProfileReport {
  ranAgainst: string;
  catalogueSync: {
    status: string;
    pages_fetched: number;
    cards_inserted: number;
    cards_updated: number;
    cards_skipped: number;
    errors: string | null;
  };
  marketProfiling: {
    cardsConsidered: number;
    cardsProfiled: number;
    cardsMissingExternalRef: number;
    cardsMissingSnapshot: number;
    snapshotsFetched: number;
    errors: string[];
  };
  catalogueTotals: {
    cardsIndexed: number;
    cardsWithNullYear: number;
    cardsWithRawValue: number;
    cardsWithAnyPsaGrade: number;
  };
  qsvCoverage: {
    snapshots: number;
    withSevenDayMedian: number;
    withThirtyDayMedian: number;
    withBothMedians: number;
    withNeitherMedian: number;
    highConfidenceQsv: number;
    note: string;
  };
  gradeEconomicClasses: { economic_class: string | null; n: number }[];
  universeEligibility: { flipEligible: number; gradeEligible: number };
  multiMarketCards: {
    count: number;
    preferenceCurrentlyUsed: string[];
    samples: { internal_card_id: string; ref_count: number; markets: string }[];
  };
}

/** Runs catalogue sync + market profiling ONLY — no eBay — bounded to a
 *  small default so a click from the dashboard can't accidentally walk an
 *  entire real catalogue. See apps/worker/src/routes/catalogue.ts and
 *  apps/worker/README.md section 11 for the full explanation; this is the
 *  same endpoint, just reachable by a button instead of curl. */
export function triggerSyncAndProfile(maxPagesPerRun = 8, pageSize = 20) {
  return request<SyncAndProfileReport>(`/catalogue/sync-and-profile`, {
    method: "POST",
    body: JSON.stringify({ maxPagesPerRun, pageSize }),
  });
}

/**
 * AI INTELLIGENCE spec Phase 2, Workstream L (natural-language query
 * interpreter). This is a STRICT, named subset of `DashboardFilters`'
 * (state/filters.ts) own field names/units, never an open-ended shape —
 * see the worker-side `InterpretedOpportunityFilters` (packages/providers)
 * this type mirrors. Every field is optional: absent/undefined means "the
 * query didn't mention this," never a fabricated default — a caller merges
 * only the fields present here onto whatever `DashboardFilters` the user
 * already had, exactly like a manually-adjusted slider would.
 */
export interface InterpretedOpportunityFilters {
  category?: "ALL" | "ACTIONABLE" | "REVIEW" | "NEAR_MISS" | "REJECTED";
  strategy?: "ALL" | "FLIP" | "GRADE";
  auctionsOnly?: boolean;
  minNetProfit?: number;
  minReturnOnCapital?: number;
  maxAcquisitionCost?: number;
  minQsv?: number;
  minLiquidity?: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
  minConfidence?: number;
  maxTotalGradedBasis?: number;
  minPsa10Profit?: number;
  minPsa9Profit?: number;
  maxBreakEvenGrade?: number;
}

export interface QueryInterpretation {
  available: boolean;
  filters: InterpretedOpportunityFilters | null;
  explanation: string | null;
  caveats: string[];
}

/** `available: false` degrades honestly (no key configured, spend cap
 *  reached, a guardrail rejection) with the reason in `caveats` — same
 *  discipline as `fetchOpportunityAdvisory`. Never throws for an
 *  AI-unavailable response; only a genuine HTTP failure throws. */
export function interpretQuery(queryText: string) {
  return request<{ interpretation: QueryInterpretation; providerName: string }>(`/query-interpret`, {
    method: "POST",
    body: JSON.stringify({ queryText }),
  });
}

/**
 * AI INTELLIGENCE spec Phase 2, Workstream M (scenario/what-if engine).
 * `overrides` is a strict subset of what the worker route accepts —
 * FLIP-only fields (`totalAcquisitionCost`, `qsv`) and GRADE-only fields
 * (`totalGradedBasis`, `slabValues`) both live on the same type since a
 * caller doesn't know the opportunity's strategy until the detail page has
 * already loaded it; the route itself only reads the fields relevant to
 * the opportunity's actual strategy, same discipline as
 * `InterpretedOpportunityFilters`. `narrate` is OFF unless explicitly
 * requested — matches `AiAdvisoryPanel`'s own on-demand-only discipline, so
 * a user iterating through several hypotheticals doesn't pay for narration
 * on every one.
 */
export interface ScenarioOverrides {
  totalAcquisitionCost?: number;
  qsv?: number;
  totalGradedBasis?: number;
  /** Grade (6-10) -> gross slab value in GBP, or null for "no market
   *  data". A grade omitted here keeps its real baseline value. */
  slabValues?: Partial<Record<6 | 7 | 8 | 9 | 10, number | null>>;
  narrate?: boolean;
}

export interface ScenarioNarration {
  available: boolean;
  summary: string | null;
  caveats: string[];
}

export interface FlipScenarioApiResult {
  strategy: "FLIP";
  scenario: FlipScenarioResult;
  narration: ScenarioNarration | null;
  providerName: string | null;
}

export interface GradeScenarioApiResult {
  strategy: "GRADE";
  scenario: GradeScenarioResult;
  narration: ScenarioNarration | null;
  providerName: string | null;
}

/** Throws (via `request`'s own !response.ok handling) on a 400/404 — e.g.
 *  no valid override supplied, or the opportunity has no baseline to
 *  scenario against — so callers should catch and surface that message,
 *  same as every other mutation-style call in this file. A 200 response's
 *  own `narration.available` still needs checking separately when
 *  `narrate: true` was sent — see `fetchOpportunityAdvisory`'s own doc
 *  comment for why that's a different, honest kind of "unavailable". */
export function runOpportunityScenario(id: string, overrides: ScenarioOverrides) {
  return request<FlipScenarioApiResult | GradeScenarioApiResult>(`/opportunities/${id}/scenario`, {
    method: "POST",
    body: JSON.stringify(overrides),
  });
}

/**
 * AI INTELLIGENCE spec Phase 2, Workstream N (AI financial auditor +
 * realised-vs-predicted reconciliation). `ForecastVsRealised`'s own fields
 * (from `@mwmc/core`) are spread flat onto each record by the worker route,
 * so this type extends it rather than duplicating the field list.
 */
export interface ReconciliationRecord extends ForecastVsRealised {
  inventoryId: string;
  cardId: string;
  cardName: string;
  strategy: "FLIP" | "GRADE";
  soldAt: string;
  /** false when this trade was never linked to an opportunity at purchase
   *  (a manually-added inventory row) — every `ForecastVsRealised` field
   *  above is then honestly null, never fabricated. */
  hasForecast: boolean;
  /** GRADE only — the grade this card actually came back as, which is
   *  which forecast column (`psaN_profit`) it was compared against. */
  actualGrade: number | null;
}

export interface ReconciliationSummary {
  overall: VarianceSummary;
  flip: VarianceSummary;
  grade: VarianceSummary;
}

export interface FinancialAudit {
  available: boolean;
  summary: string | null;
  caveats: string[];
}

/** `audit: true` additionally asks the AI financial auditor to narrate the
 *  aggregate pattern — off by default (costs real money), same discipline
 *  as `ScenarioOverrides.narrate`. Never throws for an AI-unavailable
 *  audit (`audit.available: false` with a caveat, same as every other AI
 *  feature); only a genuine HTTP failure throws. */
export function fetchReconciliation(options?: { audit?: boolean }) {
  const qs = options?.audit ? "?audit=1" : "";
  return request<{
    records: ReconciliationRecord[];
    summary: ReconciliationSummary;
    audit: FinancialAudit | null;
    providerName: string | null;
  }>(`/reconciliation${qs}`);
}
