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

export function fetchOpportunities(
  params: { strategy?: string; state?: string; limit?: number; offset?: number; qualifiedOnly?: boolean } = {},
) {
  const qs = new URLSearchParams();
  if (params.strategy && params.strategy !== "ALL") qs.set("strategy", params.strategy);
  if (params.state) qs.set("state", params.state);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  if (params.qualifiedOnly !== undefined) qs.set("qualifiedOnly", String(params.qualifiedOnly));
  const query = qs.toString();
  return request<{ opportunities: OpportunityListItem[]; total: number; limit: number; offset: number; counts: OpportunityCounts }>(
    `/opportunities${query ? `?${query}` : ""}`,
  );
}

export function fetchOpportunityDetail(id: string) {
  return request<{ opportunity: any; card: any; listing: any; reasoning: string[] }>(`/opportunities/${id}`);
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
  return request<{ cards: MarketCardItem[]; total: number; limit: number; offset: number }>(`/market${query ? `?${query}` : ""}`);
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
