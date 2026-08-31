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
  flip_score: number | null;
  grade_score: number | null;
  listing_price: number;
  total_acquisition_cost: number;
  liquidity: string;
  confidence: number;
  qsv: number | null;
  expected_net_profit: number | null;
  return_on_capital: number | null;
  profit_margin: number | null;
  total_graded_basis: number | null;
  psa8_profit: number | null;
  psa9_profit: number | null;
  psa10_profit: number | null;
  break_even_grade: string | null;
  card_name: string;
  card_set_name: string;
  card_set_code: string;
  card_number: string;
  card_edition: string;
  card_variant: string;
  card_finish: string;
  listing_title: string;
  listing_item_url: string;
}

export function fetchOpportunities(params: { strategy?: string; state?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.strategy && params.strategy !== "ALL") qs.set("strategy", params.strategy);
  if (params.state) qs.set("state", params.state);
  const query = qs.toString();
  return request<{ opportunities: OpportunityListItem[] }>(`/opportunities${query ? `?${query}` : ""}`);
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
  return request<{ scanRun: ScanRunSummary }>(`/scan-runs`, { method: "POST" });
}

export function fetchSettings() {
  return request<any>(`/settings`);
}

export interface MarketSummary {
  cardsIndexed: number;
  cardsWithMarketData: number;
  dynamicGradeCandidates: number;
  dynamicFlipMarkets: number;
  ebayListingsScanned: number;
  liveOpportunities: number;
}

export function fetchMarketSummary() {
  return request<MarketSummary>(`/market/summary`);
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
  return request<{ cards: MarketCardItem[] }>(`/market${query ? `?${query}` : ""}`);
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
