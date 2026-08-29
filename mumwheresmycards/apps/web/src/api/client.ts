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

export function fetchScanRuns() {
  return request<{ scanRuns: any[] }>(`/scan-runs`);
}

export function triggerScan() {
  return request<{ scanRun: any }>(`/scan-runs`, { method: "POST" });
}

export function fetchSettings() {
  return request<any>(`/settings`);
}
